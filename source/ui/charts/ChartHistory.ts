/**
 * When the global sample clock grows beyond this many samples, its older half
 * is thinned out to half the resolution.
 */
const MAX_CLOCK_SAMPLES = 8000;

/**
 * When a single series stores more than this many change points, its older
 * half is thinned out to half the resolution.
 */
const MAX_TRACK_POINTS = 4000;

/**
 * Index of the first element in the ascending `values` that is `> target`.
 */
export const upperBound = (values: Array<number>, target: number) => {
	let lo = 0;
	let hi = values.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (values[mid] <= target) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
};

const thinOlderHalf = (...arrays: Array<Array<number>>) => {
	const length = arrays[0].length;
	const half = Math.floor(length / 2);
	return arrays.map((array) => {
		const result: Array<number> = [];
		for (let index = 0; index < half; index += 2) {
			result.push(array[index]);
		}
		for (let index = half; index < length; ++index) {
			result.push(array[index]);
		}
		return result;
	});
};

/**
 * The history of a single value, stored as change points only. A value that
 * stays the same for hours costs as much as one that was sampled once.
 */
export class SeriesTrack {
	times: Array<number> = [];
	values: Array<number> = [];
	/**
	 * The largest finite value ever recorded.
	 */
	max = Number.NEGATIVE_INFINITY;
	/**
	 * Whether a finite value other than 0 was ever recorded.
	 */
	nonZero = false;

	private _lastValue = Number.NaN;
	private _lastSeen = Number.NaN;

	get lastValue() {
		return this._lastValue;
	}

	get lastSeen() {
		return this._lastSeen;
	}

	push(time: number, value: number) {
		const length = this.times.length;
		if (0 < length && Object.is(value, this._lastValue)) {
			this._lastSeen = time;
			return;
		}
		// Close the previous constant stretch, so lines between change points
		// stay flat until the value actually changed.
		if (0 < length && this.times[length - 1] < this._lastSeen) {
			this.times.push(this._lastSeen);
			this.values.push(this._lastValue);
		}
		this.times.push(time);
		this.values.push(value);
		this._lastValue = value;
		this._lastSeen = time;
		if (Number.isFinite(value)) {
			this.max = Math.max(this.max, value);
			this.nonZero ||= value !== 0;
		}
		if (MAX_TRACK_POINTS < this.times.length) {
			[this.times, this.values] = thinOlderHalf(this.times, this.values);
		}
	}

	/**
	 * The value the series had at the given time.
	 */
	valueAt(time: number) {
		if (this._lastSeen <= time) return this._lastValue;
		const index = upperBound(this.times, time) - 1;
		return index < 0 ? Number.NaN : this.values[index];
	}

	/**
	 * The points that describe the series between `from` and `to`, including
	 * synthetic points at both edges.
	 */
	slice(from: number, to: number): [Array<number>, Array<number>] {
		const times: Array<number> = [];
		const values: Array<number> = [];
		const startValue = this.valueAt(from);
		if (!Number.isNaN(startValue)) {
			times.push(from);
			values.push(startValue);
		}
		const end = upperBound(this.times, to);
		for (let index = upperBound(this.times, from); index < end; ++index) {
			times.push(this.times[index]);
			values.push(this.values[index]);
		}
		const last = Math.min(to, this._lastSeen);
		if (0 < times.length && times[times.length - 1] < last) {
			times.push(last);
			values.push(this.valueAt(last));
		}
		return [times, values];
	}
}

/**
 * Stores the sampled history of all tracked series.
 */
export class ChartHistory {
	/**
	 * Wall clock time of every sample, used to map times to game years.
	 */
	time: Array<number> = [];
	calendarYear: Array<number> = [];
	playedYears: Array<number> = [];
	values = new Map<string, SeriesTrack>();
	caps = new Map<string, SeriesTrack>();

	get length() {
		return this.time.length;
	}

	get start() {
		return this.time[0];
	}

	get end() {
		return this.time[this.time.length - 1];
	}

	clear() {
		this.time = [];
		this.calendarYear = [];
		this.playedYears = [];
		this.values.clear();
		this.caps.clear();
	}

	beginSample(time: number, calendarYear: number, playedYears: number) {
		this.time.push(time);
		this.calendarYear.push(calendarYear);
		this.playedYears.push(playedYears);
		if (MAX_CLOCK_SAMPLES < this.time.length) {
			[this.time, this.calendarYear, this.playedYears] = thinOlderHalf(
				this.time,
				this.calendarYear,
				this.playedYears,
			);
		}
	}

	record(id: string, time: number, value: number, cap?: number) {
		this._track(this.values, id).push(time, value);
		if (cap !== undefined) {
			this._track(this.caps, id).push(time, cap);
		}
	}

	/**
	 * Map a wall clock time onto one of the game year clocks.
	 */
	yearAt(clock: Array<number>, time: number) {
		const index = upperBound(this.time, time);
		if (index <= 0) return clock[0];
		if (this.time.length <= index) return clock[this.time.length - 1];
		const t0 = this.time[index - 1];
		const t1 = this.time[index];
		const fraction = t1 === t0 ? 0 : (time - t0) / (t1 - t0);
		return clock[index - 1] + (clock[index] - clock[index - 1]) * fraction;
	}

	private _track(store: Map<string, SeriesTrack>, id: string) {
		let track = store.get(id);
		if (track === undefined) {
			track = new SeriesTrack();
			store.set(id, track);
		}
		return track;
	}
}
