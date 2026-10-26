import { StandardChannel } from '../model/telemetry.js';
import type { Gate, GeoPoint, Track } from '../model/track.js';
import { type BuiltinValue, gpsSamples } from './builtins.js';
import type { RawSamples, ValueContext } from './types.js';

/**
 * Lap and sector values exist in two families: `imported.*` from the logger's lap data and
 * `lines.*` from crossings of the track's start/finish and sector lines. The plain ids
 * (`lap.time`, `sector.number`...) follow the project timing source; a widget can pick a family.
 */
export type TimingFamily = 'imported' | 'lines';
export const TIMING_FAMILIES: readonly TimingFamily[] = ['imported', 'lines'];

const TIMED_PREFIXES = ['lap.', 'sector.'];

/** Whether a value id has an imported and a lines version (`lap.*`, `sector.*`). */
export function isTimingValueId(id: string): boolean {
  return TIMED_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** Id of a timing value in a family (`lap.time` → `lines.lap.time`); other ids are unchanged. */
export function timingValueId(id: string, family: TimingFamily | null): string {
  return family && isTimingValueId(id) ? `${family}.${id}` : id;
}

/** Family the plain timing ids follow. */
export function resolveTimingFamily(track: Pick<Track, 'timing' | 'startFinish'>): TimingFamily {
  if (track.timing === 'auto') return track.startFinish ? 'lines' : 'imported';
  return track.timing;
}

/** Start of a lap on the timeline, with its number. */
export interface LapBoundary {
  time: number;
  lap: number;
}

/** Timeline times where the logger's lap number changes, with the new lap number. */
export function lapBoundaries(ctx: ValueContext): LapBoundary[] {
  const raw = ctx.raw(StandardChannel.lap);
  if (!raw) return [];
  const boundaries: LapBoundary[] = [];
  let previous = Number.NaN;
  let previousTime = Number.NaN;
  for (let i = 0; i < raw.time.length; i++) {
    const lap = raw.values[i] as number;
    const time = raw.time[i] as number;
    if (Number.isNaN(lap)) continue;
    // The crossing happened between the two samples: take the midpoint.
    if (!Number.isNaN(previous) && lap !== previous)
      boundaries.push({ time: (previousTime + time) / 2, lap });
    previous = lap;
    previousTime = time;
  }
  return boundaries;
}

// --- Geometry ---------------------------------------------------------------------------------

const EARTH_RADIUS = 6_371_000;
const DEG = Math.PI / 180;

interface Point {
  x: number;
  y: number;
}

/** Local meters around an origin (x east, y north), accurate over a race track. */
function projector(origin: GeoPoint): (latitude: number, longitude: number) => Point {
  const k = DEG * EARTH_RADIUS;
  const cos0 = Math.cos(origin.latitude * DEG);
  return (latitude, longitude) => ({
    x: (longitude - origin.longitude) * k * cos0,
    y: (latitude - origin.latitude) * k,
  });
}

function unproject(origin: GeoPoint, point: Point): GeoPoint {
  const k = DEG * EARTH_RADIUS;
  return {
    latitude: origin.latitude + point.y / k,
    longitude: origin.longitude + point.x / (k * Math.cos(origin.latitude * DEG)),
  };
}

const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;

/**
 * Where the move p → q crosses the line a → b: the fraction along p → q and the side it came
 * from (1 or -1), or null when it does not cross.
 */
export function segmentCrossing(p: Point, q: Point, a: Point, b: Point): { t: number; side: number } | null {
  const rx = q.x - p.x;
  const ry = q.y - p.y;
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const denominator = cross(rx, ry, sx, sy);
  if (denominator === 0) return null;
  const t = cross(a.x - p.x, a.y - p.y, sx, sy) / denominator;
  const u = cross(a.x - p.x, a.y - p.y, rx, ry) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, side: Math.sign(denominator) };
}

/**
 * Timeline times the GPS path crosses a line, interpolated between samples. Only crossings in
 * the main driving direction count, and crossings closer than `minGapSeconds` to the previous
 * one are jitter.
 */
export function gateCrossings(
  latitude: RawSamples,
  longitude: RawSamples,
  gate: Gate,
  minGapSeconds: number,
): number[] {
  const project = projector(gate.a);
  const a = project(gate.a.latitude, gate.a.longitude);
  const b = project(gate.b.latitude, gate.b.longitude);
  const found: { time: number; side: number }[] = [];
  let previous: (Point & { time: number }) | null = null;
  for (let i = 0; i < latitude.time.length; i++) {
    const lat = latitude.values[i] as number;
    const lon = longitude.values[i] as number;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    const point = { ...project(lat, lon), time: latitude.time[i] as number };
    if (previous) {
      const crossing = segmentCrossing(previous, point, a, b);
      if (crossing) {
        found.push({ time: previous.time + crossing.t * (point.time - previous.time), side: crossing.side });
      }
    }
    previous = point;
  }
  const direction = Math.sign(found.reduce((sum, c) => sum + c.side, 0)) || 1;
  const times: number[] = [];
  for (const { time, side } of found) {
    if (side !== direction) continue;
    const last = times[times.length - 1];
    if (last === undefined || time - last >= minGapSeconds) times.push(time);
  }
  return times;
}

/**
 * A start/finish line across the track where the logger's lap number changes: centred on the
 * average change position, perpendicular to the average direction of travel there.
 */
export function suggestStartFinish(
  latitude: ArrayLike<number>,
  longitude: ArrayLike<number>,
  lapNumber: ArrayLike<number>,
  halfWidthMeters = 15,
): Gate | null {
  const n = Math.min(latitude.length, longitude.length, lapNumber.length);
  const changes: number[] = [];
  let origin: GeoPoint | null = null;
  for (let i = 1; i < n; i++) {
    const before = lapNumber[i - 1] as number;
    const after = lapNumber[i] as number;
    if (!Number.isFinite(before) || !Number.isFinite(after) || before === after) continue;
    if (!Number.isFinite(latitude[i] as number) || !Number.isFinite(longitude[i] as number)) continue;
    changes.push(i);
    origin ??= { latitude: latitude[i] as number, longitude: longitude[i] as number };
  }
  if (!origin || changes.length === 0) return null;
  const project = projector(origin);
  const at = (i: number) => project(latitude[i] as number, longitude[i] as number);
  let cx = 0;
  let cy = 0;
  let dx = 0;
  let dy = 0;
  for (const i of changes) {
    const here = at(i);
    cx += here.x / changes.length;
    cy += here.y / changes.length;
    // Direction over a few frames around the change.
    const from = at(Math.max(0, i - 3));
    const to = at(Math.min(n - 1, i + 3));
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (length > 0) {
      dx += (to.x - from.x) / length;
      dy += (to.y - from.y) / length;
    }
  }
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) return null;
  // Perpendicular to the travel direction.
  const px = (-dy / length) * halfWidthMeters;
  const py = (dx / length) * halfWidthMeters;
  return {
    a: unproject(origin, { x: cx - px, y: cy - py }),
    b: unproject(origin, { x: cx + px, y: cy + py }),
  };
}

// --- Per frame values -------------------------------------------------------------------------

/** Per frame: index of the last boundary at or before the frame, -1 before the first. */
function boundaryIndex(ctx: ValueContext, times: readonly number[]): Int32Array {
  const out = new Int32Array(ctx.frameCount);
  let j = -1;
  for (let i = 0; i < ctx.frameCount; i++) {
    const t = ctx.times[i] as number;
    while (j + 1 < times.length && (times[j + 1] as number) <= t) j++;
    out[i] = j;
  }
  return out;
}

function perFrame(ctx: ValueContext, fn: (time: number, index: number) => number): Float64Array {
  const out = new Float64Array(ctx.frameCount);
  for (let i = 0; i < ctx.frameCount; i++) out[i] = fn(ctx.times[i] as number, i);
  return out;
}

/** Completed timed spans (laps or sectors) swept frame by frame. */
interface Span {
  end: number;
  duration: number;
  /** Sector number for sectors, 0 for laps. */
  index: number;
}

/** Per frame: the last completed span's duration and the best one so far (optionally of one index). */
function sweepSpans(
  ctx: ValueContext,
  spans: Span[],
  index?: number,
): { last: Float64Array; best: Float64Array } {
  const sorted = spans
    .filter((s) => Number.isFinite(s.duration) && (index === undefined || s.index === index))
    .sort((x, y) => x.end - y.end);
  const last = new Float64Array(ctx.frameCount);
  const best = new Float64Array(ctx.frameCount);
  let j = 0;
  let lastValue = Number.NaN;
  let bestValue = Number.NaN;
  for (let i = 0; i < ctx.frameCount; i++) {
    const t = ctx.times[i] as number;
    while (j < sorted.length && (sorted[j] as Span).end <= t) {
      const span = sorted[j] as Span;
      lastValue = span.duration;
      if (!(span.duration >= bestValue)) bestValue = span.duration;
      j++;
    }
    last[i] = lastValue;
    best[i] = bestValue;
  }
  return { last, best };
}

/** Values computed once per engine and shared by the values of a family. */
function memo<T>(compute: (ctx: ValueContext) => T): (ctx: ValueContext) => T {
  const cache = new WeakMap<ValueContext, T>();
  return (ctx) => {
    if (!cache.has(ctx)) cache.set(ctx, compute(ctx));
    return cache.get(ctx) as T;
  };
}

const EPSILON = 1e-6;

/** Whether the values are computed for part of the session only. */
function trimmed(ctx: ValueContext): boolean {
  return ctx.range.start > Number.NEGATIVE_INFINITY || ctx.range.end < Number.POSITIVE_INFINITY;
}

/**
 * Lap starts inside the data range, numbered from 1, plus the one closing the last kept lap
 * (it starts a lap outside the range).
 */
function keepInRange(ctx: ValueContext, list: LapBoundary[] | null): LapBoundary[] | null {
  if (!list || !trimmed(ctx)) return list;
  const { start, end } = ctx.range;
  return list
    .filter((b) => b.time >= start - EPSILON && b.time <= end + EPSILON)
    .map((b, k) => ({ time: b.time, lap: k + 1 }));
}

/** Lap values from lap starts; `number` and `count` may come from the logger instead. */
function lapValues(
  family: TimingFamily,
  source: string,
  boundaries: (ctx: ValueContext) => LapBoundary[] | null,
  overrides: { number?: BuiltinValue['compute']; count?: BuiltinValue['compute'] } = {},
): BuiltinValue[] {
  const spans = memo((ctx) => {
    const list = keepInRange(ctx, boundaries(ctx));
    if (!list) return null;
    const times = list.map((b) => b.time);
    const laps: Span[] = [];
    for (let k = 1; k < list.length; k++) {
      laps.push({
        end: times[k] as number,
        duration: (times[k] as number) - (times[k - 1] as number),
        index: 0,
      });
    }
    return { list, times, index: boundaryIndex(ctx, times), sweep: sweepSpans(ctx, laps) };
  });
  const id = (name: string) => `${family}.lap.${name}`;
  return [
    {
      info: {
        id: id('number'),
        name: `Lap (${source})`,
        description: `Current lap number, ${source}`,
        unit: '',
      },
      // In a trimmed session laps are numbered from the first kept lap, not as the logger did.
      compute: (ctx) => {
        if (overrides.number && !trimmed(ctx)) return overrides.number(ctx);
        const data = spans(ctx);
        return data && perFrame(ctx, (_, i) => data.list[data.index[i] as number]?.lap ?? Number.NaN);
      },
    },
    {
      info: {
        id: id('time'),
        name: `Lap time (${source})`,
        description: `Seconds since the current lap started (empty on the out lap), ${source}`,
        unit: 's',
      },
      compute: (ctx) => {
        const data = spans(ctx);
        return data && perFrame(ctx, (t, i) => t - (data.times[data.index[i] as number] ?? Number.NaN));
      },
    },
    {
      info: {
        id: id('last'),
        name: `Last lap (${source})`,
        description: `Last completed lap, ${source}`,
        unit: 's',
      },
      compute: (ctx) => spans(ctx)?.sweep.last ?? null,
    },
    {
      info: {
        id: id('best'),
        name: `Best lap (${source})`,
        description: `Best completed lap so far, ${source}`,
        unit: 's',
      },
      compute: (ctx) => spans(ctx)?.sweep.best ?? null,
    },
    {
      info: {
        id: id('count'),
        name: `Total laps (${source})`,
        description: `Laps of the session, ${source}`,
        unit: '',
      },
      compute: (ctx) => {
        if (overrides.count && !trimmed(ctx)) return overrides.count(ctx);
        const data = spans(ctx);
        // The boundary closing the last kept lap starts no lap of the range.
        return data ? data.list.filter((b) => b.time < ctx.range.end - EPSILON).length : null;
      },
    },
    {
      info: {
        id: id('remaining'),
        name: `Laps left (${source})`,
        description: `Total laps minus the current lap, ${source}`,
        unit: '',
      },
      compute: (ctx) => {
        const total = ctx.get(id('count'));
        return Array.from(ctx.get(id('number')), (lap, i) => (total[i] as number) - lap);
      },
    },
  ];
}

const IMPORTED = 'from the logger';
const LINES = 'from the track lines';

function importedValues(): BuiltinValue[] {
  return lapValues(
    'imported',
    IMPORTED,
    (ctx) => (ctx.has(StandardChannel.lap) ? lapBoundaries(ctx) : null),
    {
      number: (ctx) => (ctx.has(StandardChannel.lap) ? ctx.get(StandardChannel.lap) : null),
      count: (ctx) => {
        const raw = ctx.raw(StandardChannel.lap);
        if (!raw) return null;
        let max = Number.NaN;
        for (const v of raw.values) if (!Number.isNaN(v) && (Number.isNaN(max) || v > max)) max = v;
        return max;
      },
    },
  );
}

/** Crossing times of the start/finish line and of each sector line, null without a line or GPS. */
function lineCrossings(track: Track) {
  return memo((ctx) => {
    const gps = gpsSamples(ctx);
    if (!track.startFinish || !gps) return null;
    const crossings = (gate: Gate) => gateCrossings(gps.latitude, gps.longitude, gate, track.minLapSeconds);
    return { laps: crossings(track.startFinish), sectors: track.sectors.map(crossings) };
  });
}

/** Sector split times of every lap: lap start, each sector line (NaN when missed), lap end. */
function sectorSplits(crossings: { laps: number[]; sectors: number[][] }): number[][] {
  const pointers = crossings.sectors.map(() => 0);
  return crossings.laps.map((start, k) => {
    const end = crossings.laps[k + 1] ?? Number.POSITIVE_INFINITY;
    const splits = [start];
    let previous = start;
    crossings.sectors.forEach((times, j) => {
      let p = pointers[j] as number;
      while (p < times.length && (times[p] as number) <= previous) p++;
      pointers[j] = p;
      const time = times[p];
      if (time !== undefined && time < end) {
        splits.push(time);
        previous = time;
      } else {
        splits.push(Number.NaN);
      }
    });
    splits.push(Number.isFinite(end) ? end : Number.NaN);
    return splits;
  });
}

/**
 * Split times of every lap timed by the track lines: the lap start, each sector line (NaN when
 * missed) and the lap end (NaN while unfinished). Empty without a start/finish line.
 */
export function lineLapSplits(latitude: RawSamples, longitude: RawSamples, track: Track): number[][] {
  if (!track.startFinish) return [];
  const crossings = (gate: Gate) => gateCrossings(latitude, longitude, gate, track.minLapSeconds);
  return sectorSplits({ laps: crossings(track.startFinish), sectors: track.sectors.map(crossings) });
}

function lineValues(track: Track): BuiltinValue[] {
  const crossings = lineCrossings(track);
  const values = lapValues('lines', LINES, (ctx) => {
    const found = crossings(ctx);
    return found ? found.laps.map((time, k) => ({ time, lap: k + 1 })) : null;
  });
  const count = track.sectors.length + 1;
  if (count < 2) return values;

  const sectors = memo((ctx) => {
    const found = crossings(ctx);
    if (!found) return null;
    // Only the laps of the data range count (best sectors, theoretical lap).
    const laps = sectorSplits(found).filter((splits) => {
      const start = splits[0] as number;
      return start >= ctx.range.start - EPSILON && start < ctx.range.end - EPSILON;
    });
    const spans: Span[] = [];
    for (const splits of laps) {
      for (let j = 0; j < count; j++) {
        const from = splits[j] as number;
        const to = splits[j + 1] as number;
        spans.push({ end: to, duration: to - from, index: j + 1 });
      }
    }
    const lapIndex = boundaryIndex(
      ctx,
      laps.map((splits) => splits[0] as number),
    );
    // Current sector: the last split passed in the current lap.
    const current = perFrame(ctx, (t, i) => {
      const splits = laps[lapIndex[i] as number];
      if (!splits) return Number.NaN;
      let sector = Number.NaN;
      for (let j = 0; j < count; j++) if ((splits[j] as number) <= t) sector = j + 1;
      return sector;
    });
    const started = perFrame(ctx, (t, i) => {
      const splits = laps[lapIndex[i] as number];
      const sector = current[i] as number;
      return splits && Number.isFinite(sector) ? t - (splits[sector - 1] as number) : Number.NaN;
    });
    return { spans, current, started, sweep: sweepSpans(ctx, spans) };
  });
  const perSector = Array.from({ length: count }, (_, j) =>
    memo((ctx) => {
      const data = sectors(ctx);
      return data && sweepSpans(ctx, data.spans, j + 1);
    }),
  );

  values.push(
    {
      info: {
        id: 'lines.sector.number',
        name: `Sector (${LINES})`,
        description: `Current sector, ${LINES}`,
        unit: '',
      },
      compute: (ctx) => sectors(ctx)?.current ?? null,
    },
    {
      info: {
        id: 'lines.sector.time',
        name: `Sector time (${LINES})`,
        description: `Seconds since the current sector started, ${LINES}`,
        unit: 's',
      },
      compute: (ctx) => sectors(ctx)?.started ?? null,
    },
    {
      info: {
        id: 'lines.sector.last',
        name: `Last sector (${LINES})`,
        description: `Last completed sector, any sector, ${LINES}`,
        unit: 's',
      },
      compute: (ctx) => sectors(ctx)?.sweep.last ?? null,
    },
    {
      info: {
        id: 'lines.lap.theoretical',
        name: `Theoretical best lap (${LINES})`,
        description: `Sum of the best time of each sector so far, ${LINES}`,
        unit: 's',
      },
      compute: (ctx) => {
        const bests = perSector.map((sector) => sector(ctx)?.best);
        if (bests.some((b) => !b)) return null;
        return perFrame(ctx, (_, i) => bests.reduce((sum, b) => sum + ((b as Float64Array)[i] as number), 0));
      },
    },
  );
  perSector.forEach((sector, j) => {
    const n = j + 1;
    values.push(
      {
        info: {
          id: `lines.sector.${n}.last`,
          name: `Sector ${n} (${LINES})`,
          description: `Latest time of sector ${n}, ${LINES}`,
          unit: 's',
        },
        compute: (ctx) => sector(ctx)?.last ?? null,
      },
      {
        info: {
          id: `lines.sector.${n}.best`,
          name: `Best sector ${n} (${LINES})`,
          description: `Best time of sector ${n} so far, ${LINES}`,
          unit: 's',
        },
        compute: (ctx) => sector(ctx)?.best ?? null,
      },
    );
  });
  return values;
}

/**
 * Lap and sector values of a track: both families, plus the plain ids following the project
 * timing source.
 */
export function timingValues(track: Track): BuiltinValue[] {
  const families = [...importedValues(), ...lineValues(track)];
  const plain = new Map<string, BuiltinValue['info']>();
  for (const value of families) {
    const id = value.info.id.slice(value.info.id.indexOf('.') + 1);
    if (!plain.has(id)) plain.set(id, value.info);
  }
  const family = resolveTimingFamily(track);
  const aliases: BuiltinValue[] = [...plain].map(([id, info]) => ({
    info: {
      ...info,
      id,
      name: info.name.replace(/ \((from the logger|from the track lines)\)$/, ''),
      description: `${info.description.replace(/, (from the logger|from the track lines)$/, '')} (project timing source)`,
    },
    compute: (ctx) => {
      const target = timingValueId(id, family);
      return ctx.has(target) ? ctx.get(target) : null;
    },
  }));
  return [...aliases, ...families];
}
