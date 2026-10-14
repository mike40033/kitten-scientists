import type { KittenScientists } from "../../KittenScientists.js";
import { cl } from "../../tools/Log.js";
import type { DesktopUI } from "../../types/ui.js";
import { UserScriptLoader } from "../../UserScriptLoader.js";
import {
	ChartCatalog,
	type ChartGroup,
	ChartGroups,
	type SeriesDefinition,
} from "./ChartCatalog.js";
import { ChartHistory, type SeriesTrack, upperBound } from "./ChartHistory.js";
import styles from "./ChartsTab.module.css";

/**
 * How often a sample of all tracked values is taken, in milliseconds.
 */
const SAMPLE_INTERVAL = 1000;

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

/**
 * Groups whose members are sorted alphabetically in the picker. All others
 * keep the game's order.
 */
const SORTED_GROUPS: Array<ChartGroup> = ["resources", "production"];

const SETTINGS_KEY = "ks.charts";

export type ChartXAxis = "realTime" | "playedYears" | "calendarYear";
export type ChartYScale = "linear" | "log";
export type ChartYMax = "cap" | "allTime" | "visible";

type ChartSettings = {
	/**
	 * Selected series IDs, mapped to the palette slot they were assigned.
	 */
	series: Record<string, number>;
	/**
	 * Whether values are being recorded. Off by default, so nothing is
	 * collected in the background for players who don't use charts.
	 */
	recording: boolean;
	/**
	 * The series whose scale is shown on the vertical axis, if any.
	 */
	focused: string | undefined;
	xAxis: ChartXAxis;
	yScale: ChartYScale;
	yMax: ChartYMax;
	/**
	 * The visible time window in milliseconds, or `null` for everything.
	 */
	window: number | null;
	/**
	 * Picker groups that are expanded.
	 */
	openGroups: Array<ChartGroup>;
};

type SeriesScale = {
	lo: number;
	hi: number;
	project: (value: number) => number;
	fromCap: boolean;
};

const sanitize = (value: number | undefined | null) =>
	typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;

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

const escapeHtml = (text: string) =>
	text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/**
 * Adds a "Charts" tab next to the game's "Log" and "Queue" tabs, which plots
 * the history of resources and other statistics since Kitten Scientists was
 * loaded (or the game was reset).
 *
 * Every known series is recorded all the time, so a series that gets selected
 * later still shows its full history. Series only store the points where
 * their value changed, so the hundreds of rarely changing ones are cheap.
 */
export class ChartsTab {
	private readonly _host: KittenScientists;
	private readonly _history = new ChartHistory();
	private readonly _catalog: ChartCatalog;
	private _settings: ChartSettings;

	private _sampleInterval: number | undefined;
	private _visible = false;
	private _hoverX: number | undefined;
	/**
	 * A series whose scale is previewed on the axis while hovering its legend
	 * entry.
	 */
	private _previewId: string | undefined;
	private _legendSignature = "";
	private _legendItems = new Map<
		string,
		{
			item: JQuery<HTMLElement>;
			value: JQuery<HTMLElement>;
			range: JQuery<HTMLElement>;
		}
	>();
	private _recordToggle: JQuery<HTMLElement> | undefined;
	private _pickerSignature = "";
	private _pickerFilter = "";

	private _link: JQuery<HTMLElement> | undefined;
	private _tab: JQuery<HTMLElement> | undefined;
	private _canvas: HTMLCanvasElement | undefined;
	private _tooltip: JQuery<HTMLElement> | undefined;
	private _legend: JQuery<HTMLElement> | undefined;
	private _pickerSelected: JQuery<HTMLElement> | undefined;
	private _pickerGroups: JQuery<HTMLElement> | undefined;
	private _spanLabel: JQuery<HTMLElement> | undefined;
	private _windowSelect: JQuery<HTMLElement> | undefined;

	private _originalLoadLog: DesktopUI["loadLog"] | undefined;
	private _originalLoadQueue: DesktopUI["loadQueue"] | undefined;

	constructor(host: KittenScientists) {
		this._host = host;
		this._settings = this._loadSettings();
		this._catalog = new ChartCatalog(host, this._history);
		this._buildUi();
	}

	private _t(key: Parameters<KittenScientists["engine"]["i18n"]>[0]) {
		return this._host.engine.i18n(key);
	}

	private get _definitions() {
		return this._catalog.definitions;
	}

	//#region Sampling

	private _sample() {
		try {
			this._catalog.refresh();
			const calendarYear = this._catalog.calendarYear();
			const playedYears = this._catalog.playedYears();
			const history = this._history;
			const length = history.length;
			if (
				0 < length &&
				(calendarYear < history.calendarYear[length - 1] - 0.01 ||
					playedYears < history.playedYears[length - 1] - 0.01)
			) {
				// The game was reset, or an older save was loaded.
				console.info(
					...cl("Charts: game time went backwards. Clearing history."),
				);
				history.clear();
			}

			const now = Date.now();
			history.beginSample(now, calendarYear, playedYears);
			for (const definition of this._definitions.values()) {
				let value = Number.NaN;
				let cap: number | undefined;
				try {
					value = sanitize(definition.read());
					cap = definition.readCap ? sanitize(definition.readCap()) : undefined;
				} catch (_error: unknown) {
					// Some game values can't be computed in every game state.
				}
				history.record(definition.id, now, value, cap);
			}

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

	/**
	 * Starts recording, if the user enabled it.
	 */
	start() {
		if (this._settings.recording) {
			this._startSampling();
		}
	}

	private _startSampling() {
		if (this._sampleInterval !== undefined) {
			return;
		}
		this._sample();
		this._sampleInterval = UserScriptLoader.window.setInterval(
			() => this._sample(),
			SAMPLE_INTERVAL,
		);
	}

	private _stopSampling() {
		if (this._sampleInterval !== undefined) {
			UserScriptLoader.window.clearInterval(this._sampleInterval);
			this._sampleInterval = undefined;
		}
	}

	private _setRecording(recording: boolean) {
		this._settings.recording = recording;
		this._storeSettings();
		if (recording) {
			this._startSampling();
		} else {
			// Pause. The history stays, and the pause shows up as a gap.
			this._stopSampling();
			this._history.pause();
		}
		this._refreshPicker(true);
		this.render();
	}

	destroy() {
		this._stopSampling();
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
			focused: undefined,
			openGroups: ["overview"],
			recording: false,
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
		} else {
			delete series[id];
			if (this._settings.focused === id) {
				this._settings.focused = undefined;
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
			WINDOW_PRESETS.some(([, value]) => value === this._settings.window)
				? String(this._settings.window)
				: "custom",
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
				if (this._settings.recording) this._sample();
				this.render();
			});
		this._recordToggle = $("<input/>", { type: "checkbox" })
			.prop("checked", this._settings.recording)
			.on("change", () =>
				this._setRecording(this._recordToggle?.prop("checked") as boolean),
			);

		const controls = $("<div/>")
			.addClass(styles.controls)
			.append(
				$("<label/>", { title: this._t("ui.charts.recordHint") })
					.addClass(styles.record)
					.append(this._recordToggle, ` ${this._t("ui.charts.record")}`),
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
		const filter = $("<input/>", {
			placeholder: this._t("ui.charts.filter"),
			type: "search",
		}).on("input", () => {
			this._pickerFilter = String(filter.val()).trim().toLowerCase();
			this._refreshPicker(true);
		});
		this._pickerSelected = $("<div/>").addClass(styles.selected);
		this._pickerGroups = $("<div/>");
		const picker = $("<div/>")
			.addClass(styles.picker)
			.append(
				$("<div/>")
					.addClass(styles.pickerHeading)
					.text(this._t("ui.charts.series").replace("{0}", String(MAX_SERIES))),
				this._pickerSelected,
				filter,
				this._pickerGroups,
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
		this._refreshPicker(true);
		this.render();
	}

	private _hide() {
		this._link?.toggleClass("active", false);
		this._tab?.hide();
		this._visible = false;
	}

	private _zoom(factor: number) {
		const history = this._history;
		const fullSpan = 1 < history.length ? history.end - history.start : 0;
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

	private _onToggle(id: string, checked: boolean) {
		if (!this._toggleSeries(id, checked)) {
			this._host.engine.imessage("ui.charts.tooMany", [String(MAX_SERIES)]);
		}
		this._refreshPicker(true);
		this.render();
	}

	private _checkbox(definition: SeriesDefinition, label = definition.label) {
		const checkbox = $("<input/>", { type: "checkbox" }).prop(
			"checked",
			definition.id in this._settings.series,
		);
		checkbox.on("change", () =>
			this._onToggle(definition.id, checkbox.prop("checked") as boolean),
		);
		return $("<label/>", { title: definition.longLabel }).append(
			checkbox,
			` ${label}`,
		);
	}

	/**
	 * Rebuilds the series picker, if anything in it changed.
	 */
	private _refreshPicker(force = false) {
		if (!this._pickerGroups || !this._pickerSelected) return;

		const filter = this._pickerFilter;
		const matches = (definition: SeriesDefinition) =>
			filter === "" ||
			definition.longLabel.toLowerCase().includes(filter) ||
			(definition.subgroup ?? "").toLowerCase().includes(filter);
		const offered = (definition: SeriesDefinition) =>
			(definition.available() || definition.id in this._settings.series) &&
			matches(definition);

		const groups = ChartGroups.map(
			(group) =>
				[group, this._catalog.membersOf(group).filter(offered)] as const,
		).filter(([, members]) => 0 < members.length);

		const signature = JSON.stringify([
			filter,
			this._settings.series,
			groups.map(([group, members]) => [
				group,
				members.map((member) => member.id),
			]),
		]);
		if (!force && signature === this._pickerSignature) return;
		this._pickerSignature = signature;

		// The currently selected series, for quick removal.
		this._pickerSelected.empty();
		for (const [id, slot] of Object.entries(this._settings.series)) {
			const definition = this._definitions.get(id);
			const chip = $("<a/>", { href: "#", title: this._t("ui.charts.remove") })
				.addClass(styles.chip)
				.append(
					$("<span/>")
						.addClass(styles.swatch)
						.css("background", this._palette()[slot % MAX_SERIES]),
					` ${definition?.longLabel ?? id} ✕`,
				)
				.on("click", (event) => {
					event.preventDefault();
					this._onToggle(id, false);
				});
			this._pickerSelected.append(chip);
		}

		this._pickerGroups.empty();
		for (const [group, members] of groups) {
			const selectedCount = members.filter(
				(member) => member.id in this._settings.series,
			).length;
			const open = filter !== "" || this._settings.openGroups.includes(group);
			const details = $("<details/>")
				.addClass(styles.group)
				.prop("open", open)
				.append(
					$("<summary/>").text(
						`${this._t(`ui.charts.group.${group}`)} (${selectedCount ? `${selectedCount}/` : ""}${members.length})`,
					),
				);
			details.on("toggle", () => {
				if (filter !== "") return;
				const isOpen = details.prop("open") as boolean;
				const openGroups = new Set(this._settings.openGroups);
				if (isOpen) openGroups.add(group);
				else openGroups.delete(group);
				this._settings.openGroups = [...openGroups];
				this._storeSettings();
			});

			// Bucket members by subgroup, keeping the order of first appearance.
			const subgroups = new Map<string, Array<SeriesDefinition>>();
			for (const member of members) {
				// The overview mixes groups, so its members show their long label.
				const key = group === "overview" ? "" : (member.subgroup ?? "");
				subgroups.set(key, [...(subgroups.get(key) ?? []), member]);
			}
			for (const [subgroup, subMembers] of subgroups) {
				if (SORTED_GROUPS.includes(group)) {
					subMembers.sort((a, b) => a.label.localeCompare(b.label));
				}
				if (subgroup !== "") {
					details.append($("<div/>").addClass(styles.subgroup).text(subgroup));
				}
				const options = $("<div/>").addClass(styles.options);
				for (const member of subMembers) {
					options.append(
						this._checkbox(
							member,
							group === "overview" ? member.longLabel : member.label,
						),
					);
				}
				details.append(options);
			}
			this._pickerGroups.append(details);
		}
		if (groups.length === 0) {
			this._pickerGroups.append(
				$("<div/>").addClass(styles.hint).text(this._t("ui.charts.noMatch")),
			);
		}
	}

	//#endregion

	//#region Rendering

	private _palette() {
		return this._isDark(this._surfaceColor()) ? PALETTE_DARK : PALETTE_LIGHT;
	}

	private _format(id: string, value: number) {
		if (!Number.isFinite(value)) return "–";
		const definition = this._definitions.get(id);
		return definition?.format
			? definition.format(value)
			: this._host.game.getDisplayValueExt(value);
	}

	private _scaleFor(
		id: string,
		values: Array<number>,
		from: number,
		to: number,
	): SeriesScale | undefined {
		let min = Number.POSITIVE_INFINITY;
		let max = Number.NEGATIVE_INFINITY;
		let minPositive = Number.POSITIVE_INFINITY;
		for (const value of values) {
			if (!Number.isFinite(value)) continue;
			min = Math.min(min, value);
			max = Math.max(max, value);
			if (0 < value) minPositive = Math.min(minPositive, value);
		}
		if (!Number.isFinite(max)) return undefined;

		const allTimeMax = this._history.values.get(id)?.max ?? max;
		let hi = max;
		let fromCap = false;
		if (this._settings.yMax === "cap") {
			const [, caps] = this._history.caps.get(id)?.slice(from, to) ?? [[], []];
			let cap = Number.NEGATIVE_INFINITY;
			for (const value of caps) {
				if (Number.isFinite(value)) cap = Math.max(cap, value);
			}
			if (0 < cap) {
				hi = Math.max(cap, max);
				fromCap = true;
			} else {
				hi = Math.max(max, allTimeMax);
			}
		} else if (this._settings.yMax === "allTime") {
			hi = Math.max(max, allTimeMax);
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

	/**
	 * The year clock for the current x axis, or `undefined` for real time.
	 */
	private _clock(): Array<number> | undefined {
		switch (this._settings.xAxis) {
			case "calendarYear":
				return this._history.calendarYear;
			case "playedYears":
				return this._history.playedYears;
			default:
				return undefined;
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
		const palette = this._isDark(surface) ? PALETTE_DARK : PALETTE_LIGHT;
		this._tooltip?.css({
			"--ks-charts-surface": surface,
			"--ks-charts-text": textColor,
		});
		context.font = "10px sans-serif";

		const history = this._history;
		const selected: Array<[string, number, SeriesTrack]> = [];
		for (const [id, slot] of Object.entries(this._settings.series)) {
			const track = history.values.get(id);
			if (track) selected.push([id, slot, track]);
		}

		if (history.length < 2 || selected.length === 0) {
			context.fillStyle = textColor;
			context.textAlign = "center";
			context.fillText(
				this._t(
					!this._settings.recording
						? "ui.charts.notRecording"
						: history.length < 2
							? "ui.charts.collecting"
							: "ui.charts.empty",
				),
				width / 2,
				height / 2,
			);
			this._legend.empty();
			this._legendSignature = "";
			this._legendItems.clear();
			this._tooltip?.hide();
			this._spanLabel?.text("");
			return;
		}

		// Determine the visible time range.
		const now = history.end;
		const windowStart =
			this._settings.window === null
				? history.start
				: Math.max(history.start, now - this._settings.window);
		this._spanLabel?.text(
			this._t("ui.charts.showing").replace(
				"{0}",
				formatDuration(now - windowStart),
			),
		);

		const clock = this._clock();
		const xOf = (time: number) =>
			clock === undefined ? time : history.yearAt(clock, time);
		const xMin = xOf(windowStart);
		let xMax = xOf(now);
		if (xMax <= xMin) xMax = xMin + (clock === undefined ? 1000 : 0.001);

		// With several series there is no single meaningful scale, so numbers are
		// only shown for one the user picked (or hovers in the legend).
		const axisId =
			this._previewId !== undefined && this._previewId in this._settings.series
				? this._previewId
				: this._settings.focused !== undefined &&
						this._settings.focused in this._settings.series
					? this._settings.focused
					: selected.length === 1
						? selected[0][0]
						: undefined;

		const area = { bottom: height - 18, left: 46, right: width - 6, top: 18 };
		const toX = (value: number) =>
			area.left + ((value - xMin) / (xMax - xMin)) * (area.right - area.left);
		const toY = (fraction: number) =>
			area.bottom -
			Math.min(1, Math.max(0, fraction)) * (area.bottom - area.top);

		const slices = new Map<string, [Array<number>, Array<number>]>();
		const scales = new Map<string, SeriesScale>();
		for (const [id, , track] of selected) {
			const slice = track.slice(windowStart, now);
			slices.set(id, slice);
			const scale = this._scaleFor(id, slice[1], windowStart, now);
			if (scale) scales.set(id, scale);
		}

		// Grid, and the y labels of the axis series.
		context.strokeStyle = textColor;
		context.fillStyle = textColor;
		context.lineWidth = 1;
		const axisScale = axisId !== undefined ? scales.get(axisId) : undefined;
		context.textAlign = "right";
		context.textBaseline = "middle";
		if (axisId === undefined || axisScale === undefined) {
			for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
				const y = Math.round(toY(fraction)) + 0.5;
				context.globalAlpha = 0.15;
				context.beginPath();
				context.moveTo(area.left, y);
				context.lineTo(area.right, y);
				context.stroke();
			}
			context.globalAlpha = 0.6;
			context.textAlign = "left";
			context.fillText(this._t("ui.charts.axisNone"), area.left, 8);
		} else {
			const focusedScale = axisScale;
			const focusedId = axisId;
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
			// Name the series the numbers belong to.
			const slot = this._settings.series[focusedId] ?? 0;
			context.globalAlpha = 1;
			context.fillStyle = palette[slot % palette.length];
			context.fillRect(area.left, 7, 14, 3);
			context.fillStyle = textColor;
			context.textAlign = "left";
			context.fillText(
				this._definitions.get(focusedId)?.longLabel ?? focusedId,
				area.left + 18,
				8,
			);
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
			clock === undefined
				? ([1 / 6, 1 / 2, 1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440]
						.map((minutes) => minutes * 60000)
						.find((step) => xSpan / step <= 5) ?? xSpan)
				: niceStep(xSpan, 4);
		const labelSpan = clock === undefined ? xSpan : xStep * 4;
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

		// Series lines. The axis series is drawn last, so it is on top, and
		// the others step back a little.
		const ordered = [...selected].sort(([a], [b]) =>
			a === axisId ? 1 : b === axisId ? -1 : 0,
		);
		for (const [id, slot] of ordered) {
			const scale = scales.get(id);
			const slice = slices.get(id);
			if (!scale || !slice) continue;
			const [times, values] = slice;
			context.strokeStyle = palette[slot % palette.length];
			context.lineWidth = id === axisId ? 2.5 : 1.5;
			context.globalAlpha =
				axisId === undefined || id === axisId || selected.length === 1
					? 1
					: 0.55;
			context.lineJoin = "round";
			// Stretches where recording was paused are drawn dashed.
			const solid = new Path2D();
			const dashed = new Path2D();
			let previous: [number, number, number] | undefined;
			for (let index = 0; index < times.length; ++index) {
				const fraction = scale.project(values[index]);
				if (!Number.isFinite(fraction)) {
					previous = undefined;
					continue;
				}
				const time = times[index];
				const x = toX(xOf(time));
				const y = toY(fraction);
				if (previous === undefined) {
					solid.moveTo(x, y);
					previous = [time, x, y];
					continue;
				}
				const [t0, , y0] = previous;
				const at = (t: number): [number, number] => [
					toX(xOf(t)),
					y0 + ((y - y0) * (t - t0)) / (time - t0),
				];
				for (const [start, end] of history.gapsBetween(t0, time)) {
					const [gapStartX, gapStartY] = at(Math.max(start, t0));
					const [gapEndX, gapEndY] = at(Math.min(end, time));
					solid.lineTo(gapStartX, gapStartY);
					dashed.moveTo(gapStartX, gapStartY);
					dashed.lineTo(gapEndX, gapEndY);
					solid.moveTo(gapEndX, gapEndY);
				}
				solid.lineTo(x, y);
				previous = [time, x, y];
			}
			context.stroke(solid);
			context.setLineDash([4, 4]);
			context.stroke(dashed);
			context.setLineDash([]);
		}
		context.globalAlpha = 1;

		// Hover crosshair and tooltip.
		let hoverTime: number | undefined;
		if (this._hoverX !== undefined && area.left <= this._hoverX) {
			const target =
				xMin +
				((this._hoverX - area.left) / (area.right - area.left)) * (xMax - xMin);
			// Snap to the nearest sample.
			const axis = clock ?? history.time;
			const first = upperBound(history.time, windowStart - 1);
			let index = Math.min(
				history.length - 1,
				Math.max(first, upperBound(axis, target)),
			);
			if (first < index && target - axis[index - 1] < axis[index] - target) {
				index -= 1;
			}
			const time = history.time[index];
			hoverTime = time;
			const x = toX(axis[index]);
			context.strokeStyle = textColor;
			context.globalAlpha = 0.4;
			context.lineWidth = 1;
			context.beginPath();
			context.moveTo(Math.round(x) + 0.5, area.top);
			context.lineTo(Math.round(x) + 0.5, area.bottom);
			context.stroke();
			context.globalAlpha = 1;
			for (const [id, slot, track] of selected) {
				const scale = scales.get(id);
				if (!scale) continue;
				const fraction = scale.project(track.valueAt(time));
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
					`<div>${formatClock(time, true)} · ${this._t("ui.charts.yearShort")} ${history.calendarYear[index].toFixed(2)}</div>`,
					...selected.map(
						([id, slot, track]) =>
							`<div><span class="${styles.swatch}" style="background:${palette[slot % palette.length]}"></span> ${escapeHtml(this._definitions.get(id)?.longLabel ?? id)}: ${escapeHtml(this._format(id, track.valueAt(time)))}</div>`,
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

		// Legend. Only rebuilt when the selection changes, so hovering an entry
		// isn't interrupted by every refresh.
		const legendTime = hoverTime ?? now;
		const legendSignature = selected
			.map(([id, slot]) => `${id}=${slot}`)
			.join();
		if (legendSignature !== this._legendSignature) {
			this._legendSignature = legendSignature;
			this._legend.empty();
			this._legendItems.clear();
			for (const [id, slot] of selected) {
				const value = $("<span/>").addClass(styles.legendValue);
				const range = $("<span/>").addClass(styles.legendRange);
				const item = $("<li/>")
					.attr("title", this._t("ui.charts.focusHint"))
					.append(
						$("<span/>")
							.addClass(styles.swatch)
							.css("background", palette[slot % palette.length]),
						$("<span/>").text(this._definitions.get(id)?.longLabel ?? id),
						value,
						range,
					)
					.on("click", () => {
						// Clicking the axis series again takes its numbers off the axis.
						this._settings.focused =
							this._settings.focused === id ? undefined : id;
						this._previewId = undefined;
						this._storeSettings();
						this.render();
					})
					.on("mouseenter", () => {
						this._previewId = id;
						this.render();
					})
					.on("mouseleave", () => {
						this._previewId = undefined;
						this.render();
					});
				this._legendItems.set(id, { item, range, value });
				this._legend.append(item);
			}
		}
		for (const [id, , track] of selected) {
			const entry = this._legendItems.get(id);
			if (!entry) continue;
			const scale = scales.get(id);
			entry.item.toggleClass(styles.focused, id === axisId);
			entry.value.text(this._format(id, track.valueAt(legendTime)));
			entry.range.text(
				scale
					? `[${this._format(id, scale.lo)} – ${this._format(id, scale.hi)}${scale.fromCap ? ` ${this._t("ui.charts.capShort")}` : ""}]`
					: "",
			);
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
