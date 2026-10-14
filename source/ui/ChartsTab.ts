import type { KittenScientists } from "../KittenScientists.js";
import { ucfirst } from "../tools/Format.js";
import { cl } from "../tools/Log.js";
import type { DesktopUI } from "../types/ui.js";
import { UserScriptLoader } from "../UserScriptLoader.js";
import styles from "./ChartsTab.module.css";

/**
 * How often a sample of all tracked values is taken, in milliseconds.
 */
const SAMPLE_INTERVAL = 1000;

/**
 * When the history grows beyond this many samples, the older half is thinned
 * out to half its resolution. Recent history always keeps full resolution.
 */
const MAX_SAMPLES = 8000;

/**
 * The shortest selectable time window.
 */
const MIN_WINDOW = 5 * 60 * 1000;

const WINDOW_PRESETS: Array<[string, number | null]> = [
	["5m", 5 * 60 * 1000],
	["15m", 15 * 60 * 1000],
	["1h", 60 * 60 * 1000],
	["3h", 3 * 60 * 60 * 1000],
	["12h", 12 * 60 * 60 * 1000],
	["all", null],
];

/**
 * Categorical series colors, assigned in fixed order. Light and dark variants
 * of the same hues, for the light and dark game color schemes.
 */
const PALETTE_LIGHT = [
	"#2a78d6",
	"#eb6834",
	"#1baf7a",
	"#eda100",
	"#e87ba4",
	"#008300",
	"#6250d6",
	"#e34948",
];
const PALETTE_DARK = [
	"#3987e5",
	"#d95926",
	"#199e70",
	"#c98500",
	"#d55181",
	"#008300",
	"#9085e9",
	"#e66767",
];
const MAX_SERIES = PALETTE_LIGHT.length;

const SETTINGS_KEY = "ks.charts";

export type ChartXAxis = "realTime" | "playedYears" | "calendarYear";
export type ChartYScale = "linear" | "log";
export type ChartYMax = "cap" | "allTime" | "visible";

type ChartSettings = {
	/**
	 * Selected series IDs, mapped to the palette slot they were assigned.
	 */
	series: Record<string, number>;
	focused: string | undefined;
	xAxis: ChartXAxis;
	yScale: ChartYScale;
	yMax: ChartYMax;
	/**
	 * The visible time window in milliseconds, or `null` for everything.
	 */
	window: number | null;
};

type SeriesDefinition = {
	id: string;
	group: "stats" | "resources";
	label: string;
	read: () => number;
	readCap?: () => number;
	/**
	 * Whether this series should be offered in the picker right now.
	 */
	available: () => boolean;
	format?: (value: number) => string;
};

type SeriesScale = {
	lo: number;
	hi: number;
	project: (value: number) => number;
	fromCap: boolean;
};

/**
 * Stores the sampled history of all tracked series.
 */
class ChartHistory {
	time: Array<number> = [];
	calendarYear: Array<number> = [];
	playedYears: Array<number> = [];
	values = new Map<string, Array<number>>();
	caps = new Map<string, Array<number>>();
	allTimeMax = new Map<string, number>();

	get length() {
		return this.time.length;
	}

	clear() {
		this.time = [];
		this.calendarYear = [];
		this.playedYears = [];
		this.values.clear();
		this.caps.clear();
		this.allTimeMax.clear();
	}

	record(
		definitions: Iterable<SeriesDefinition>,
		time: number,
		calendarYear: number,
		playedYears: number,
	) {
		const length = this.length;
		for (const definition of definitions) {
			const value = sanitize(definition.read());
			this._push(this.values, definition.id, value, length);
			if (definition.readCap) {
				this._push(
					this.caps,
					definition.id,
					sanitize(definition.readCap()),
					length,
				);
			}
			if (Number.isFinite(value)) {
				const previous = this.allTimeMax.get(definition.id);
				if (previous === undefined || previous < value) {
					this.allTimeMax.set(definition.id, value);
				}
			}
		}
		this.time.push(time);
		this.calendarYear.push(calendarYear);
		this.playedYears.push(playedYears);

		if (MAX_SAMPLES < this.length) {
			this._thin();
		}
	}

	private _push(
		store: Map<string, Array<number>>,
		id: string,
		value: number,
		length: number,
	) {
		let series = store.get(id);
		if (series === undefined) {
			// Series that appear later are padded so all arrays stay aligned.
			series = new Array<number>(length).fill(Number.NaN);
			store.set(id, series);
		}
		series.push(value);
	}

	/**
	 * Halve the resolution of the older half of the history.
	 */
	private _thin() {
		const half = Math.floor(this.length / 2);
		const thin = (series: Array<number>) => {
			const result: Array<number> = [];
			for (let index = 0; index < half; index += 2) {
				result.push(series[index]);
			}
			for (let index = half; index < series.length; ++index) {
				result.push(series[index]);
			}
			return result;
		};
		this.time = thin(this.time);
		this.calendarYear = thin(this.calendarYear);
		this.playedYears = thin(this.playedYears);
		for (const [id, series] of this.values) {
			this.values.set(id, thin(series));
		}
		for (const [id, series] of this.caps) {
			this.caps.set(id, thin(series));
		}
	}
}

const sanitize = (value: number | undefined | null) =>
	typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;

/**
 * Index of the first element in the ascending `values` that is `>= target`.
 */
const lowerBound = (values: Array<number>, target: number) => {
	let lo = 0;
	let hi = values.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (values[mid] < target) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
};

/**
 * A "nice" step size (1, 2 or 5 times a power of ten) to split `range` into
 * roughly `count` intervals.
 */
const niceStep = (range: number, count: number) => {
	const raw = range / Math.max(1, count);
	const magnitude = 10 ** Math.floor(Math.log10(raw));
	const residual = raw / magnitude;
	if (5 < residual) return 10 * magnitude;
	if (2 < residual) return 5 * magnitude;
	if (1 < residual) return 2 * magnitude;
	return magnitude;
};

const formatDuration = (milliseconds: number) => {
	if (milliseconds < 60000) return `${Math.round(milliseconds / 1000)}s`;
	const minutes = Math.round(milliseconds / 60000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
};

const formatClock = (time: number, withSeconds: boolean) => {
	const date = new Date(time);
	const pad = (value: number) => value.toString().padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}${withSeconds ? `:${pad(date.getSeconds())}` : ""}`;
};

/**
 * Adds a "Charts" tab next to the game's "Log" and "Queue" tabs, which plots
 * the history of resources and other statistics since Kitten Scientists was
 * loaded (or the game was reset).
 */
export class ChartsTab {
	private readonly _host: KittenScientists;
	private readonly _history = new ChartHistory();
	private readonly _definitions = new Map<string, SeriesDefinition>();
	private _settings: ChartSettings;

	private _sampleInterval: number | undefined;
	private _visible = false;
	private _hoverX: number | undefined;
	private _pickerSignature = "";

	private _link: JQuery<HTMLElement> | undefined;
	private _tab: JQuery<HTMLElement> | undefined;
	private _canvas: HTMLCanvasElement | undefined;
	private _tooltip: JQuery<HTMLElement> | undefined;
	private _legend: JQuery<HTMLElement> | undefined;
	private _pickerOptions: JQuery<HTMLElement> | undefined;
	private _pickerFilter = "";
	private _spanLabel: JQuery<HTMLElement> | undefined;
	private _windowSelect: JQuery<HTMLElement> | undefined;

	private _originalLoadLog: DesktopUI["loadLog"] | undefined;
	private _originalLoadQueue: DesktopUI["loadQueue"] | undefined;

	constructor(host: KittenScientists) {
		this._host = host;
		this._settings = this._loadSettings();
		this._defineSeries();
		this._buildUi();
	}

	private _t(key: Parameters<KittenScientists["engine"]["i18n"]>[0]) {
		return this._host.engine.i18n(key);
	}

	//#region Series

	private _defineSeries() {
		const game = this._host.game;
		const stats: Array<SeriesDefinition> = [
			{
				available: () => true,
				format: (value) => value.toFixed(2),
				group: "stats",
				id: "stat:year",
				label: this._t("ui.charts.series.year"),
				read: () => this._calendarYear(),
			},
			{
				available: () => true,
				format: (value) => value.toFixed(3),
				group: "stats",
				id: "stat:playedYears",
				label: this._t("ui.charts.series.playedYears"),
				read: () => this._playedYears(),
			},
			{
				available: () => 0 < (game.resPool.get("kittens")?.value ?? 0),
				format: (value) => `${Math.round(value)}%`,
				group: "stats",
				id: "stat:happiness",
				label: this._t("ui.charts.series.happiness"),
				read: () => game.village.happiness * 100,
			},
			{
				available: () => 0 < game.bld.cathPollution,
				group: "stats",
				id: "stat:pollution",
				label: this._t("ui.charts.series.pollution"),
				read: () => game.bld.cathPollution,
			},
			{
				available: () => 0 < game.religion.faith,
				group: "stats",
				id: "stat:worship",
				label: this._t("ui.charts.series.worship"),
				read: () => game.religion.faith,
			},
			{
				available: () => 0 < game.religion.faithRatio,
				group: "stats",
				id: "stat:epiphany",
				label: this._t("ui.charts.series.epiphany"),
				read: () => game.religion.faithRatio,
			},
			{
				available: () =>
					0 < game.resPool.energyProd || 0 < game.resPool.energyCons,
				group: "stats",
				id: "stat:energy",
				label: this._t("ui.charts.series.energy"),
				read: () => game.resPool.energyProd - game.resPool.energyCons,
			},
		];
		for (const definition of stats) {
			this._definitions.set(definition.id, definition);
		}
		this._refreshResourceDefinitions();
	}

	/**
	 * Resources can be added by the game at runtime, so this is re-run on
	 * every sample.
	 */
	private _refreshResourceDefinitions() {
		for (const resource of this._host.game.resPool.resources) {
			const id = `res:${resource.name}`;
			if (this._definitions.has(id)) {
				continue;
			}
			this._definitions.set(id, {
				available: () =>
					resource.unlocked === true || 0 < (resource.value ?? 0),
				group: "resources",
				id,
				label: ucfirst(resource.title || resource.name),
				read: () => resource.value ?? Number.NaN,
				readCap: () => resource.maxValue ?? Number.NaN,
			});
		}
	}

	private _calendarYear() {
		const calendar = this._host.game.calendar;
		const daysPerYear = calendar.daysPerSeason * calendar.seasonsPerYear;
		return (
			calendar.year +
			(calendar.season * calendar.daysPerSeason + calendar.day) / daysPerYear
		);
	}

	/**
	 * Game time that was actually simulated (excluding time skips), in years.
	 */
	private _playedYears() {
		const calendar = this._host.game.calendar;
		const ticksPerYear =
			calendar.ticksPerDay * calendar.daysPerSeason * calendar.seasonsPerYear;
		return this._host.game.ticks / ticksPerYear;
	}

	private _sample() {
		try {
			this._refreshResourceDefinitions();
			const calendarYear = this._calendarYear();
			const playedYears = this._playedYears();
			const length = this._history.length;
			if (
				0 < length &&
				(calendarYear < this._history.calendarYear[length - 1] - 0.01 ||
					playedYears < this._history.playedYears[length - 1] - 0.01)
			) {
				// The game was reset, or an older save was loaded.
				console.info(
					...cl("Charts: game time went backwards. Clearing history."),
				);
				this._history.clear();
			}
			this._history.record(
				this._definitions.values(),
				Date.now(),
				calendarYear,
				playedYears,
			);
			if (this._visible) {
				this._refreshPicker();
				this.render();
			}
		} catch (error: unknown) {
			console.error(...cl("Charts: failed to take sample.", error));
		}
	}

	//#endregion

	//#region Lifecycle

	start() {
		if (this._sampleInterval !== undefined) {
			return;
		}
		this._sample();
		this._sampleInterval = UserScriptLoader.window.setInterval(
			() => this._sample(),
			SAMPLE_INTERVAL,
		);
	}

	destroy() {
		if (this._sampleInterval !== undefined) {
			UserScriptLoader.window.clearInterval(this._sampleInterval);
			this._sampleInterval = undefined;
		}
		const ui = this._host.game.ui;
		if (this._originalLoadLog !== undefined) {
			ui.loadLog = this._originalLoadLog;
		}
		if (this._originalLoadQueue !== undefined) {
			ui.loadQueue = this._originalLoadQueue;
		}
		if (this._visible) {
			ui.loadLog();
		}
		this._link?.remove();
		this._tab?.remove();
		$(UserScriptLoader.window).off("resize.ksCharts");
	}

	//#endregion

	//#region Settings

	private _loadSettings(): ChartSettings {
		const defaults: ChartSettings = {
			focused: "res:catnip",
			series: { "res:catnip": 0, "res:kittens": 1 },
			window: null,
			xAxis: "realTime",
			yMax: "cap",
			yScale: "linear",
		};
		try {
			const stored = localStorage.getItem(SETTINGS_KEY);
			if (stored) {
				return {
					...defaults,
					...(JSON.parse(stored) as Partial<ChartSettings>),
				};
			}
		} catch (error: unknown) {
			console.warn(...cl("Charts: unable to load settings.", error));
		}
		return defaults;
	}

	private _storeSettings() {
		try {
			localStorage.setItem(SETTINGS_KEY, JSON.stringify(this._settings));
		} catch (_error: unknown) {
			// Settings just won't persist.
		}
	}

	private _toggleSeries(id: string, enabled: boolean) {
		const series = this._settings.series;
		if (enabled) {
			if (id in series) return true;
			const used = new Set(Object.values(series));
			const slot = [...Array(MAX_SERIES).keys()].find(
				(index) => !used.has(index),
			);
			if (slot === undefined) {
				return false;
			}
			series[id] = slot;
			this._settings.focused = this._settings.focused ?? id;
		} else {
			delete series[id];
			if (this._settings.focused === id) {
				this._settings.focused = Object.keys(series)[0];
			}
		}
		this._storeSettings();
		return true;
	}

	//#endregion

	//#region DOM

	private _buildUi() {
		const header = $("#rightColumn .right-tab-header");
		if (header.length === 0) {
			console.warn(
				...cl(
					"Charts: unable to find the Log/Queue tab header. Charts tab disabled.",
				),
			);
			return;
		}

		const ui = this._host.game.ui;
		this._originalLoadLog = ui.loadLog;
		this._originalLoadQueue = ui.loadQueue;
		const originalLoadLog = this._originalLoadLog;
		const originalLoadQueue = this._originalLoadQueue;
		ui.loadLog = () => {
			this._hide();
			originalLoadLog.call(ui);
		};
		ui.loadQueue = () => {
			this._hide();
			originalLoadQueue.call(ui);
		};

		this._link = $("<a/>", { href: "#", id: "ksChartsLink" })
			.text(this._t("ui.charts.tab"))
			.on("click", (event) => {
				event.preventDefault();
				this._show();
			});
		header.append(" ", this._link);

		this._tab = $("<div/>", { id: "ksRightTabCharts" })
			.addClass("right-tab")
			.addClass(styles.tab)
			.hide();

		// Controls
		const select = (
			options: Array<[string, string]>,
			value: string,
			onChange: (value: string) => void,
		) => {
			const element = $("<select/>");
			for (const [optionValue, label] of options) {
				element.append($("<option/>", { value: optionValue }).text(label));
			}
			element.val(value);
			element.on("change", () => onChange(String(element.val())));
			return element;
		};
		const labeled = (label: string, control: JQuery<HTMLElement>) =>
			$("<label/>").text(`${label} `).append(control);

		const xAxisSelect = select(
			[
				["realTime", this._t("ui.charts.xAxis.realTime")],
				["playedYears", this._t("ui.charts.xAxis.playedYears")],
				["calendarYear", this._t("ui.charts.xAxis.calendarYear")],
			],
			this._settings.xAxis,
			(value) => {
				this._settings.xAxis = value as ChartXAxis;
				this._storeSettings();
				this.render();
			},
		);
		this._windowSelect = select(
			[
				...WINDOW_PRESETS.map(([label, value]): [string, string] => [
					String(value),
					label === "all" ? this._t("ui.charts.window.all") : label,
				]),
				["custom", this._t("ui.charts.window.custom")],
			],
			String(this._settings.window),
			(value) => {
				if (value === "custom") return;
				this._settings.window = value === "null" ? null : Number(value);
				this._storeSettings();
				this.render();
			},
		);
		const yScaleSelect = select(
			[
				["linear", this._t("ui.charts.yScale.linear")],
				["log", this._t("ui.charts.yScale.log")],
			],
			this._settings.yScale,
			(value) => {
				this._settings.yScale = value as ChartYScale;
				this._storeSettings();
				this.render();
			},
		);
		const yMaxSelect = select(
			[
				["cap", this._t("ui.charts.yMax.cap")],
				["allTime", this._t("ui.charts.yMax.allTime")],
				["visible", this._t("ui.charts.yMax.visible")],
			],
			this._settings.yMax,
			(value) => {
				this._settings.yMax = value as ChartYMax;
				this._storeSettings();
				this.render();
			},
		);
		this._spanLabel = $("<span/>").addClass(styles.span);
		const clearLink = $("<a/>", { href: "#" })
			.text(this._t("ui.charts.clear"))
			.on("click", (event) => {
				event.preventDefault();
				this._history.clear();
				this._sample();
			});

		const controls = $("<div/>")
			.addClass(styles.controls)
			.append(
				labeled(this._t("ui.charts.xAxis"), xAxisSelect),
				labeled(this._t("ui.charts.window"), this._windowSelect),
				labeled(this._t("ui.charts.yScale"), yScaleSelect),
				labeled(this._t("ui.charts.yMax"), yMaxSelect),
				this._spanLabel,
				clearLink,
			);

		// Plot
		this._canvas = document.createElement("canvas");
		this._canvas.className = styles.canvas;
		this._tooltip = $("<div/>").addClass(styles.tooltip).hide();
		const plot = $("<div/>")
			.addClass(styles.plot)
			.append(this._canvas, this._tooltip);
		$(this._canvas)
			.on("mousemove", (event) => {
				this._hoverX = event.offsetX;
				this.render();
			})
			.on("mouseleave", () => {
				this._hoverX = undefined;
				this.render();
			})
			.on("wheel", (event) => {
				event.preventDefault();
				const delta = (event.originalEvent as WheelEvent).deltaY;
				this._zoom(0 < delta ? 1.25 : 0.8);
			});
		$(UserScriptLoader.window).on("resize.ksCharts", () => this.render());

		this._legend = $("<ul/>").addClass(styles.legend);
		const hint = $("<div/>")
			.addClass(styles.hint)
			.text(this._t("ui.charts.hint"));

		// Series picker
		this._pickerOptions = $("<div/>");
		const filter = $("<input/>", {
			placeholder: this._t("ui.charts.filter"),
			type: "search",
		}).on("input", () => {
			this._pickerFilter = String(filter.val()).toLowerCase();
			this._pickerSignature = "";
			this._refreshPicker();
		});
		const picker = $("<details/>")
			.addClass(styles.picker)
			.attr("open", "")
			.append(
				$("<summary/>").text(
					this._t("ui.charts.series").replace("{0}", String(MAX_SERIES)),
				),
				filter,
				this._pickerOptions,
			);

		this._tab.append(controls, plot, this._legend, hint, picker);
		$("#rightColumn").append(this._tab);
	}

	private _show() {
		if (!this._tab) return;
		$("#rightTabLog").hide();
		$("#rightTabQueue").hide();
		$("#logLink").toggleClass("active", false);
		$("#queueLink").toggleClass("active", false);
		this._link?.toggleClass("active", true);
		this._tab.show();
		this._visible = true;
		this._pickerSignature = "";
		this._refreshPicker();
		this.render();
	}

	private _hide() {
		this._link?.toggleClass("active", false);
		this._tab?.hide();
		this._visible = false;
	}

	private _zoom(factor: number) {
		const history = this._history;
		const fullSpan =
			1 < history.length
				? history.time[history.length - 1] - history.time[0]
				: 0;
		const current = this._settings.window ?? Math.max(fullSpan, MIN_WINDOW);
		const next = Math.max(MIN_WINDOW, current * factor);
		this._settings.window = fullSpan <= next && 1 < factor ? null : next;
		const preset = WINDOW_PRESETS.find(
			([, value]) => value === this._settings.window,
		);
		this._windowSelect?.val(preset ? String(preset[1]) : "custom");
		this._storeSettings();
		this.render();
	}

	private _refreshPicker() {
		if (!this._pickerOptions) return;
		const available = [...this._definitions.values()].filter(
			(definition) =>
				(definition.available() || definition.id in this._settings.series) &&
				definition.label.toLowerCase().includes(this._pickerFilter),
		);
		// Only rebuild when the set of offered series changes.
		const signature = available.map((definition) => definition.id).join(",");
		if (signature === this._pickerSignature) return;
		this._pickerSignature = signature;

		this._pickerOptions.empty();
		for (const group of ["stats", "resources"] as const) {
			const members = available
				.filter((definition) => definition.group === group)
				.sort((a, b) =>
					group === "resources" ? a.label.localeCompare(b.label) : 0,
				);
			if (members.length === 0) continue;
			const options = $("<div/>").addClass(styles.options);
			for (const definition of members) {
				const checkbox = $("<input/>", { type: "checkbox" }).prop(
					"checked",
					definition.id in this._settings.series,
				);
				checkbox.on("change", () => {
					const checked = checkbox.prop("checked") as boolean;
					if (!this._toggleSeries(definition.id, checked)) {
						checkbox.prop("checked", false);
						this._host.engine.imessage("ui.charts.tooMany", [
							String(MAX_SERIES),
						]);
					}
					this.render();
				});
				options.append(
					$("<label/>", { title: definition.label }).append(
						checkbox,
						` ${definition.label}`,
					),
				);
			}
			this._pickerOptions.append(
				$("<div/>")
					.addClass(styles.group)
					.text(this._t(`ui.charts.group.${group}`)),
				options,
			);
		}
	}

	//#endregion

	//#region Rendering

	private _format(id: string, value: number) {
		if (!Number.isFinite(value)) return "–";
		const definition = this._definitions.get(id);
		return definition?.format
			? definition.format(value)
			: this._host.game.getDisplayValueExt(value);
	}

	private _scaleFor(
		id: string,
		from: number,
		to: number,
	): SeriesScale | undefined {
		const values = this._history.values.get(id);
		if (values === undefined) return undefined;

		let min = Number.POSITIVE_INFINITY;
		let max = Number.NEGATIVE_INFINITY;
		let minPositive = Number.POSITIVE_INFINITY;
		for (let index = from; index < to; ++index) {
			const value = values[index];
			if (!Number.isFinite(value)) continue;
			min = Math.min(min, value);
			max = Math.max(max, value);
			if (0 < value) minPositive = Math.min(minPositive, value);
		}
		if (!Number.isFinite(max)) return undefined;

		let hi = max;
		let fromCap = false;
		if (this._settings.yMax === "cap") {
			const caps = this._history.caps.get(id);
			let cap = Number.NEGATIVE_INFINITY;
			if (caps) {
				for (let index = from; index < to; ++index) {
					if (Number.isFinite(caps[index])) cap = Math.max(cap, caps[index]);
				}
			}
			if (0 < cap) {
				hi = Math.max(cap, max);
				fromCap = true;
			} else {
				hi = this._history.allTimeMax.get(id) ?? max;
			}
		} else if (this._settings.yMax === "allTime") {
			hi = Math.max(max, this._history.allTimeMax.get(id) ?? max);
		}

		if (this._settings.yScale === "log") {
			if (!(0 < hi)) return undefined;
			let lo = Number.isFinite(minPositive) ? minPositive : hi / 10;
			lo = 10 ** Math.floor(Math.log10(lo));
			if (hi <= lo) lo = hi / 10;
			const logLo = Math.log10(lo);
			const logRange = Math.log10(hi) - logLo;
			return {
				fromCap,
				hi,
				lo,
				project: (value) =>
					0 < value ? (Math.log10(value) - logLo) / logRange : Number.NaN,
			};
		}

		const lo = Math.min(0, min);
		if (hi <= lo) hi = lo + 1;
		return {
			fromCap,
			hi,
			lo,
			project: (value) => (value - lo) / (hi - lo),
		};
	}

	private _xValues(): Array<number> {
		switch (this._settings.xAxis) {
			case "calendarYear":
				return this._history.calendarYear;
			case "playedYears":
				return this._history.playedYears;
			default:
				return this._history.time;
		}
	}

	private _formatX(value: number, span: number) {
		if (this._settings.xAxis === "realTime") {
			return formatClock(value, span < 10 * 60 * 1000);
		}
		const step = niceStep(span, 4);
		const decimals = Math.max(0, -Math.floor(Math.log10(step)));
		return value.toFixed(Math.min(decimals, 4));
	}

	render() {
		const canvas = this._canvas;
		if (!this._visible || !canvas || !this._legend) return;

		const width = canvas.clientWidth;
		const height = canvas.clientHeight;
		if (width === 0 || height === 0) return;
		const ratio = UserScriptLoader.window.devicePixelRatio || 1;
		if (canvas.width !== Math.round(width * ratio))
			canvas.width = Math.round(width * ratio);
		if (canvas.height !== Math.round(height * ratio))
			canvas.height = Math.round(height * ratio);
		const context = canvas.getContext("2d");
		if (!context) return;
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		context.clearRect(0, 0, width, height);

		// Pick up the colors of the current game theme.
		const columnStyle = UserScriptLoader.window.getComputedStyle(
			$("#rightColumn")[0] ?? document.body,
		);
		const textColor = columnStyle.color || "#000";
		const surface = this._surfaceColor();
		const dark = this._isDark(surface);
		const palette = dark ? PALETTE_DARK : PALETTE_LIGHT;
		this._tooltip?.css({
			"--ks-charts-surface": surface,
			"--ks-charts-text": textColor,
		});
		context.font = "10px sans-serif";

		const history = this._history;
		const length = history.length;
		const selected = Object.entries(this._settings.series).filter(([id]) =>
			history.values.has(id),
		);

		if (length < 2 || selected.length === 0) {
			context.fillStyle = textColor;
			context.textAlign = "center";
			context.fillText(
				this._t(length < 2 ? "ui.charts.collecting" : "ui.charts.empty"),
				width / 2,
				height / 2,
			);
			this._legend.empty();
			this._tooltip?.hide();
			this._spanLabel?.text("");
			return;
		}

		// Determine the visible sample range.
		const now = history.time[length - 1];
		const windowStart =
			this._settings.window === null
				? history.time[0]
				: now - this._settings.window;
		let from = lowerBound(history.time, windowStart);
		if (length - from < 2) from = length - 2;
		const to = length;
		this._spanLabel?.text(
			this._t("ui.charts.showing").replace(
				"{0}",
				formatDuration(now - history.time[from]),
			),
		);

		const xs = this._xValues();
		const xMin = xs[from];
		let xMax = xs[to - 1];
		if (xMax <= xMin)
			xMax = xMin + (this._settings.xAxis === "realTime" ? 1000 : 0.001);

		const area = { bottom: height - 18, left: 46, right: width - 6, top: 6 };
		const toX = (value: number) =>
			area.left + ((value - xMin) / (xMax - xMin)) * (area.right - area.left);
		const toY = (fraction: number) =>
			area.bottom -
			Math.min(1, Math.max(0, fraction)) * (area.bottom - area.top);

		const focusedId =
			this._settings.focused && this._settings.focused in this._settings.series
				? this._settings.focused
				: selected[0][0];

		const scales = new Map<string, SeriesScale>();
		for (const [id] of selected) {
			const scale = this._scaleFor(id, from, to);
			if (scale) scales.set(id, scale);
		}

		// Grid and y labels of the focused series.
		context.strokeStyle = textColor;
		context.fillStyle = textColor;
		context.lineWidth = 1;
		const focusedScale = scales.get(focusedId);
		context.textAlign = "right";
		context.textBaseline = "middle";
		if (focusedScale) {
			const ticks: Array<number> = [];
			if (this._settings.yScale === "log") {
				const first = Math.ceil(Math.log10(focusedScale.lo));
				const last = Math.floor(Math.log10(focusedScale.hi));
				const every = Math.max(1, Math.ceil((last - first + 1) / 6));
				for (let exponent = first; exponent <= last; exponent += every) {
					ticks.push(10 ** exponent);
				}
			} else {
				const step = niceStep(focusedScale.hi - focusedScale.lo, 4);
				for (
					let value = Math.ceil(focusedScale.lo / step) * step;
					value <= focusedScale.hi + step * 1e-9;
					value += step
				) {
					ticks.push(value);
				}
			}
			for (const tick of ticks) {
				const y = Math.round(toY(focusedScale.project(tick))) + 0.5;
				context.globalAlpha = 0.15;
				context.beginPath();
				context.moveTo(area.left, y);
				context.lineTo(area.right, y);
				context.stroke();
				context.globalAlpha = 0.8;
				context.fillText(this._format(focusedId, tick), area.left - 4, y);
			}
		}

		// X axis.
		context.globalAlpha = 0.5;
		context.beginPath();
		context.moveTo(area.left, area.bottom + 0.5);
		context.lineTo(area.right, area.bottom + 0.5);
		context.stroke();
		context.globalAlpha = 0.8;
		context.textBaseline = "top";
		const xSpan = xMax - xMin;
		const xStep =
			this._settings.xAxis === "realTime"
				? ([1 / 6, 1 / 2, 1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440]
						.map((minutes) => minutes * 60000)
						.find((step) => xSpan / step <= 5) ?? xSpan)
				: niceStep(xSpan, 4);
		const labelSpan = this._settings.xAxis === "realTime" ? xSpan : xStep * 4;
		for (
			let value = Math.ceil(xMin / xStep) * xStep;
			value <= xMax;
			value += xStep
		) {
			const x = toX(value);
			context.textAlign =
				x < area.left + 20 ? "left" : x > area.right - 20 ? "right" : "center";
			context.fillText(this._formatX(value, labelSpan), x, area.bottom + 4);
		}
		context.globalAlpha = 1;

		// Series lines. The focused series is drawn last, so it is on top.
		const ordered = [...selected].sort(([a], [b]) =>
			a === focusedId ? 1 : b === focusedId ? -1 : 0,
		);
		for (const [id, slot] of ordered) {
			const scale = scales.get(id);
			const values = history.values.get(id);
			if (!scale || !values) continue;
			context.strokeStyle = palette[slot % palette.length];
			context.lineWidth = id === focusedId ? 2 : 1.5;
			context.lineJoin = "round";
			context.beginPath();
			let penDown = false;
			for (let index = from; index < to; ++index) {
				const fraction = scale.project(values[index]);
				if (!Number.isFinite(fraction)) {
					penDown = false;
					continue;
				}
				const x = toX(xs[index]);
				const y = toY(fraction);
				if (penDown) {
					context.lineTo(x, y);
				} else {
					context.moveTo(x, y);
					penDown = true;
				}
			}
			context.stroke();
		}

		// Hover crosshair and tooltip.
		let hoverIndex: number | undefined;
		if (this._hoverX !== undefined && area.left <= this._hoverX) {
			const target =
				xMin +
				((this._hoverX - area.left) / (area.right - area.left)) * (xMax - xMin);
			let index = Math.min(to - 1, Math.max(from, lowerBound(xs, target)));
			if (from < index && target - xs[index - 1] < xs[index] - target)
				index -= 1;
			hoverIndex = index;
			const x = toX(xs[index]);
			context.strokeStyle = textColor;
			context.globalAlpha = 0.4;
			context.lineWidth = 1;
			context.beginPath();
			context.moveTo(Math.round(x) + 0.5, area.top);
			context.lineTo(Math.round(x) + 0.5, area.bottom);
			context.stroke();
			context.globalAlpha = 1;
			for (const [id, slot] of selected) {
				const scale = scales.get(id);
				const value = history.values.get(id)?.[index];
				if (!scale || value === undefined) continue;
				const fraction = scale.project(value);
				if (!Number.isFinite(fraction)) continue;
				context.fillStyle = palette[slot % palette.length];
				context.strokeStyle = surface;
				context.lineWidth = 2;
				context.beginPath();
				context.arc(x, toY(fraction), 4, 0, Math.PI * 2);
				context.fill();
				context.stroke();
			}

			if (this._tooltip) {
				const lines = [
					`<div>${formatClock(history.time[index], true)} · ${this._t("ui.charts.yearShort")} ${history.calendarYear[index].toFixed(2)}</div>`,
					...selected.map(
						([id, slot]) =>
							`<div><span class="${styles.swatch}" style="background:${palette[slot % palette.length]}"></span> ${escapeHtml(this._definitions.get(id)?.label ?? id)}: ${this._format(id, history.values.get(id)?.[index] ?? Number.NaN)}</div>`,
					),
				];
				this._tooltip.html(lines.join("")).show();
				const tooltipWidth = this._tooltip.outerWidth() ?? 0;
				const left =
					x + 12 + tooltipWidth < width
						? x + 12
						: Math.max(0, x - 12 - tooltipWidth);
				this._tooltip.css({ left: `${left}px`, top: `${area.top}px` });
			}
		} else {
			this._tooltip?.hide();
		}

		// Legend.
		const legendIndex = hoverIndex ?? to - 1;
		this._legend.empty();
		for (const [id, slot] of selected) {
			const scale = scales.get(id);
			const range = scale
				? `[${this._format(id, scale.lo)} – ${this._format(id, scale.hi)}${scale.fromCap ? ` ${this._t("ui.charts.capShort")}` : ""}]`
				: "";
			const item = $("<li/>")
				.toggleClass(styles.focused, id === focusedId)
				.attr("title", this._t("ui.charts.focusHint"))
				.append(
					$("<span/>")
						.addClass(styles.swatch)
						.css("background", palette[slot % palette.length]),
					$("<span/>").text(this._definitions.get(id)?.label ?? id),
					$("<span/>")
						.addClass(styles.legendValue)
						.text(
							this._format(
								id,
								history.values.get(id)?.[legendIndex] ?? Number.NaN,
							),
						),
					$("<span/>").addClass(styles.legendRange).text(range),
				)
				.on("click", () => {
					this._settings.focused = id;
					this._storeSettings();
					this.render();
				});
			this._legend.append(item);
		}
	}

	private _surfaceColor() {
		let element: HTMLElement | null = $("#rightColumn")[0] ?? null;
		while (element) {
			const background =
				UserScriptLoader.window.getComputedStyle(element).backgroundColor;
			if (
				background &&
				background !== "transparent" &&
				!/rgba\(.*,\s*0\)$/.test(background)
			) {
				return background;
			}
			element = element.parentElement;
		}
		return "#ffffff";
	}

	private _isDark(color: string) {
		const match = color.match(/\d+(\.\d+)?/g);
		if (!match || match.length < 3) return false;
		const [r, g, b] = match.map(Number);
		return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
	}

	//#endregion
}

const escapeHtml = (text: string) =>
	text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
