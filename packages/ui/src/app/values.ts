import { type DataRange, dataRangeKey, type ValueSeries } from '@custom-overlay/core';
import type { ValuesSnapshot } from '../shared/api';

/** Value of a snapshot at a timeline time (nearest frame). */
export function snapshotValue(snapshot: ValuesSnapshot, id: string, time: number): number {
  const { start, frameRate, count } = snapshot.grid;
  const frame = Math.min(Math.max(Math.round((time - start) * frameRate), 0), Math.max(count - 1, 0));
  return snapshot.data[id]?.[frame] ?? Number.NaN;
}

/** A snapshot as the whole-session series widgets read. */
export function snapshotSeries(snapshot: ValuesSnapshot): ValueSeries {
  const { start, frameRate, count } = snapshot.grid;
  const times = new Float64Array(count).map((_, i) => start + i / frameRate);
  return { times, get: (id) => snapshot.data[id] };
}

const cachedSeries = new WeakMap<object, Map<string, ValueSeries>>();

/** A series over some data of a snapshot, the same object for the same data (prepared caches). */
function seriesOver(snapshot: ValuesSnapshot, key: string, data: Record<string, Float64Array>): ValueSeries {
  let byKey = cachedSeries.get(snapshot);
  if (!byKey) {
    byKey = new Map();
    cachedSeries.set(snapshot, byKey);
  }
  let series = byKey.get(key);
  if (!series) {
    const times = snapshotSeries(snapshot).times;
    series = { times, get: (id) => data[id] };
    byKey.set(key, series);
  }
  return series;
}

/** Whole-session positions and laps (no data range): Track map, lap bounds. */
export function fullSeries(snapshot: ValuesSnapshot): ValueSeries {
  return seriesOver(snapshot, ':full', snapshot.full);
}

/** The series a widget reads: its own data range's, or the project's. */
export function widgetSeries(
  snapshot: ValuesSnapshot,
  base: ValueSeries,
  widget: { dataRange: DataRange | null },
): ValueSeries {
  const key = dataRangeKey(widget.dataRange);
  const data = key ? snapshot.ranges[key] : undefined;
  return data ? seriesOver(snapshot, key, data) : base;
}
