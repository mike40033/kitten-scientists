import type { KittenScientists } from "../../KittenScientists.js";
import { ucfirst } from "../../tools/Format.js";
import type { ChartHistory } from "./ChartHistory.js";

export const ChartGroups = [
	"overview",
	"time",
	"village",
	"resources",
	"production",
	"buildings",
	"science",
	"religion",
	"energy",
	"trade",
	"statistics",
	"ks",
] as const;
export type ChartGroup = (typeof ChartGroups)[number];

export type SeriesDefinition = {
	id: string;
	group: ChartGroup;
	/**
	 * Already translated subgroup heading, if any.
	 */
	subgroup?: string;
	/**
	 * The label shown in the picker, inside its (sub)group.
	 */
	label: string;
	/**
	 * The label shown in the legend and tooltip, where the group isn't visible.
	 */
	longLabel: string;
	read: () => number;
	readCap?: () => number;
	/**
	 * Whether this series should be offered in the picker right now.
	 */
	available: () => boolean;
	format?: (value: number) => string;
};

/**
 * Series that are listed in the "Overview" group, in addition to their own.
 */
const OVERVIEW = [
	"stat:year",
	"res:kittens",
	"stat:happiness",
	"stat:pollution",
	"stat:energy",
	"res:paragon",
	"res:karma",
	"stat:worship",
	"res:unobtainium",
	"res:gflops",
	"res:timeCrystal",
	"res:relic",
	"res:void",
];

/**
 * The game's metadata objects (buildings, upgrades, techs, ...) share these
 * fields, but are typed individually.
 */
type Countable = {
	name: string;
	label?: string;
	title?: string;
	val?: number;
	unlocked?: boolean;
	researched?: boolean;
	stage?: number;
	stages?: Array<{ label: string }>;
	calculate?: (game: unknown) => number;
};

const asCountables = (items: unknown) =>
	(items ?? []) as unknown as Array<Countable>;

const always = () => true;

const formatInteger = (value: number) => Math.round(value).toLocaleString();

/**
 * Knows about every value that can be charted, and how to read it.
 */
export class ChartCatalog {
	readonly definitions = new Map<string, SeriesDefinition>();
	private readonly _host: KittenScientists;
	private readonly _history: ChartHistory;

	constructor(host: KittenScientists, history: ChartHistory) {
		this._host = host;
		this._history = history;
		this._defineFixed();
		this.refresh();
	}

	/**
	 * All definitions in a group, including the overview's references.
	 */
	membersOf(group: ChartGroup): Array<SeriesDefinition> {
		if (group === "overview") {
			return OVERVIEW.map((id) => this.definitions.get(id)).filter(
				(definition): definition is SeriesDefinition =>
					definition !== undefined,
			);
		}
		return [...this.definitions.values()].filter(
			(definition) => definition.group === group,
		);
	}

	private _t(key: Parameters<KittenScientists["engine"]["i18n"]>[0]) {
		return this._host.engine.i18n(key);
	}

	private _add(
		definition: Omit<SeriesDefinition, "longLabel"> & { longLabel?: string },
	) {
		if (this.definitions.has(definition.id)) return;
		this.definitions.set(definition.id, {
			...definition,
			longLabel: definition.longLabel ?? definition.label,
		});
	}

	/**
	 * Offered once something other than zero was recorded.
	 */
	private _seenNonZero(id: string) {
		return () => this._history.values.get(id)?.nonZero === true;
	}

	private _defineFixed() {
		const game = this._host.game;

		// Time
		this._add({
			available: always,
			format: (value) => value.toFixed(2),
			group: "time",
			id: "stat:year",
			label: this._t("ui.charts.series.year"),
			read: () => this.calendarYear(),
		});
		this._add({
			available: always,
			format: (value) => value.toFixed(3),
			group: "time",
			id: "stat:playedYears",
			label: this._t("ui.charts.series.playedYears"),
			read: () => this.playedYears(),
		});
		this._add({
			available: this._seenNonZero("stat:heat"),
			group: "time",
			id: "stat:heat",
			label: this._t("ui.charts.series.heat"),
			read: () => game.time.heat,
		});

		// Village
		this._add({
			available: () => 0 < (game.resPool.get("kittens")?.value ?? 0),
			format: (value) => `${Math.round(value)}%`,
			group: "village",
			id: "stat:happiness",
			label: this._t("ui.charts.series.happiness"),
			read: () => game.village.happiness * 100,
		});
		this._add({
			available: this._seenNonZero("stat:leaderRank"),
			format: formatInteger,
			group: "village",
			id: "stat:leaderRank",
			label: this._t("ui.charts.series.leaderRank"),
			read: () => game.village.leader?.rank ?? Number.NaN,
		});
		const jobs = this._t("ui.charts.subgroup.jobs");
		for (const job of game.village.jobs) {
			const label = ucfirst(job.title || job.name);
			this._add({
				available: () => job.unlocked,
				format: formatInteger,
				group: "village",
				id: `job:${job.name}`,
				label,
				longLabel: `${jobs}: ${label}`,
				read: () => job.value,
				subgroup: jobs,
			});
		}

		// Science
		const count =
			(items: () => unknown, predicate: (item: Countable) => boolean) => () =>
				asCountables(items()).filter(predicate).length;
		const scienceCounts: Array<[string, () => number]> = [
			[
				"techs",
				count(
					() => game.science.techs,
					(item) => item.researched === true,
				),
			],
			[
				"upgrades",
				count(
					() => game.workshop.upgrades,
					(item) => item.researched === true,
				),
			],
			[
				"policies",
				count(
					() => game.science.policies,
					(item) => item.researched === true,
				),
			],
			[
				"achievements",
				count(
					() => game.achievements.achievements,
					(item) => item.unlocked === true,
				),
			],
		];
		for (const [name, read] of scienceCounts) {
			this._add({
				available: always,
				format: formatInteger,
				group: "science",
				id: `stat:${name}`,
				label: this._t(
					`ui.charts.series.${name}` as Parameters<ChartCatalog["_t"]>[0],
				),
				read,
			});
		}

		// Religion
		this._add({
			available: this._seenNonZero("stat:worship"),
			group: "religion",
			id: "stat:worship",
			label: this._t("ui.charts.series.worship"),
			read: () => game.religion.faith,
		});
		this._add({
			available: this._seenNonZero("stat:epiphany"),
			group: "religion",
			id: "stat:epiphany",
			label: this._t("ui.charts.series.epiphany"),
			read: () => game.religion.faithRatio,
		});
		this._add({
			available: this._seenNonZero("stat:transcendenceTier"),
			format: formatInteger,
			group: "religion",
			id: "stat:transcendenceTier",
			label: this._t("ui.charts.series.transcendenceTier"),
			read: () => game.religion.transcendenceTier,
		});

		// Energy & pollution
		this._add({
			available: this._seenNonZero("stat:pollution"),
			group: "energy",
			id: "stat:pollution",
			label: this._t("ui.charts.series.pollution"),
			read: () => game.bld.cathPollution,
		});
		this._add({
			available: this._seenNonZero("stat:energyProduction"),
			group: "energy",
			id: "stat:energy",
			label: this._t("ui.charts.series.energy"),
			read: () => game.resPool.energyProd - game.resPool.energyCons,
		});
		this._add({
			available: this._seenNonZero("stat:energyProduction"),
			group: "energy",
			id: "stat:energyProduction",
			label: this._t("ui.charts.series.energyProduction"),
			read: () => game.resPool.energyProd,
		});
		this._add({
			available: this._seenNonZero("stat:energyConsumption"),
			group: "energy",
			id: "stat:energyConsumption",
			label: this._t("ui.charts.series.energyConsumption"),
			read: () => game.resPool.energyCons,
		});

		// Trade
		this._add({
			available: this._seenNonZero("res:blackcoin"),
			group: "trade",
			id: "stat:blackcoinPrice",
			label: this._t("ui.charts.series.blackcoinPrice"),
			read: () => game.calendar.cryptoPrice,
		});
		const embassies = this._t("ui.charts.subgroup.embassies");
		for (const race of game.diplomacy.races) {
			const label = ucfirst(race.title || race.name);
			this._add({
				available: () => race.unlocked,
				format: formatInteger,
				group: "trade",
				id: `embassy:${race.name}`,
				label,
				longLabel: `${embassies}: ${label}`,
				read: () => race.embassyLevel,
				subgroup: embassies,
			});
		}

		// Buildings
		const buildingSets: Array<[string, () => Array<Countable>]> = [
			["bonfire", () => asCountables(game.bld.buildingsData)],
			[
				"space",
				() =>
					game.space.planets.flatMap((planet) =>
						asCountables(planet.buildings),
					),
			],
			["ziggurat", () => asCountables(game.religion.zigguratUpgrades)],
			["orderOfTheSun", () => asCountables(game.religion.religionUpgrades)],
			[
				"cryptotheology",
				() => asCountables(game.religion.transcendenceUpgrades),
			],
			["chronoforge", () => asCountables(game.time.chronoforgeUpgrades)],
			["voidSpace", () => asCountables(game.time.voidspaceUpgrades)],
		];
		for (const [set, items] of buildingSets) {
			const subgroup = this._t(
				`ui.charts.subgroup.${set}` as Parameters<ChartCatalog["_t"]>[0],
			);
			for (const building of items()) {
				const label = () =>
					ucfirst(
						building.stages?.[building.stage ?? 0]?.label ??
							building.label ??
							building.title ??
							building.name,
					);
				const id = `bld:${set}:${building.name}`;
				this._add({
					// Some buildings are flagged as unlocked long before they can be
					// built, so only offer those that were actually owned.
					available: this._seenNonZero(id),
					format: formatInteger,
					group: "buildings",
					id,
					label: label(),
					longLabel: `${subgroup}: ${label()}`,
					read: () => building.val ?? Number.NaN,
					subgroup,
				});
			}
		}
	}

	/**
	 * Picks up series whose sources can appear while the game is running.
	 */
	refresh() {
		const game = this._host.game;
		// Wood is flagged as craftable, because it can be refined from catnip,
		// but it is really a basic resource.
		const subgroupOf = (resource: {
			name: string;
			type: string;
			craftable?: boolean;
		}) =>
			this._t(
				`ui.charts.subgroup.${resource.craftable && resource.name !== "wood" ? "crafted" : resource.type}` as Parameters<
					ChartCatalog["_t"]
				>[0],
			);

		for (const resource of game.resPool.resources) {
			const label = ucfirst(resource.title || resource.name);
			const subgroup = subgroupOf(resource);
			this._add({
				available: () =>
					resource.unlocked === true || 0 < (resource.value ?? 0),
				group: "resources",
				id: `res:${resource.name}`,
				label,
				read: () => resource.value ?? Number.NaN,
				readCap: () => resource.maxValue ?? Number.NaN,
				subgroup,
			});
			const rateId = `rate:${resource.name}`;
			const rateLabel = this._t("ui.charts.series.rate").replace("{0}", label);
			this._add({
				available: this._seenNonZero(rateId),
				format: (value) => `${game.getDisplayValueExt(value, true)}/s`,
				group: "production",
				id: rateId,
				label,
				longLabel: rateLabel,
				read: () =>
					game.getResourcePerTick(resource.name, true) *
					game.getTicksPerSecondUI(),
				subgroup,
			});
		}

		const statSets: Array<[string, Array<Countable>]> = [
			["allTime", asCountables(game.stats.stats)],
			["thisGame", asCountables(game.stats.statsCurrent)],
		];
		for (const [set, stats] of statSets) {
			const subgroup = this._t(
				`ui.charts.subgroup.${set}` as Parameters<ChartCatalog["_t"]>[0],
			);
			for (const stat of stats) {
				const label = ucfirst(stat.title || stat.name);
				this._add({
					available: () => stat.unlocked === true,
					group: "statistics",
					id: `gamestat:${set}:${stat.name}`,
					label,
					longLabel: `${label} (${subgroup})`,
					read: () =>
						stat.calculate ? stat.calculate(game) : (stat.val ?? Number.NaN),
					subgroup,
				});
			}
		}

		const summary = this._host.engine.activitySummary;
		for (const [activity, entries] of summary.activities) {
			const subgroup = this._t(
				`ui.charts.ks.${activity}` as Parameters<ChartCatalog["_t"]>[0],
			);
			for (const name of entries.keys()) {
				const label = ucfirst(name === activity ? subgroup : name);
				this._add({
					available: always,
					group: "ks",
					id: `ks:${activity}:${name}`,
					label,
					longLabel: name === activity ? subgroup : `${subgroup}: ${label}`,
					// The summary is replaced when the user resets it.
					read: () => summary.activities.get(activity)?.get(name) ?? 0,
					subgroup,
				});
			}
		}
	}

	calendarYear() {
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
	playedYears() {
		const calendar = this._host.game.calendar;
		const ticksPerYear =
			calendar.ticksPerDay * calendar.daysPerSeason * calendar.seasonsPerYear;
		return this._host.game.ticks / ticksPerYear;
	}
}
