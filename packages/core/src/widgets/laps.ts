import type { ValueSeries } from './types.js';

/** One lap of the session, as seen by the lap widgets. */
export interface Lap {
  /** Lap number (from the lap number value, else counted from 1). */
  number: number;
  /** Timeline time the lap starts. */
  start: number;
  /** Seconds the lap took, NaN while unfinished (the last lap of the data). */
  duration: number;
}

/**
 * Laps from the per frame lap time (seconds since the lap start): a lap starts where the lap time
 * first has a value or drops. The lap number value names the laps when present.
 */
export function lapsFromSeries(series: ValueSeries, lapTimeId: string, lapNumberId: string): Lap[] {
  const lapTime = series.get(lapTimeId);
  if (!lapTime) return [];
  const lapNumber = series.get(lapNumberId);
  const laps: Lap[] = [];
  let previous = Number.NaN;
  for (let i = 0; i < lapTime.length; i++) {
    const value = lapTime[i] as number;
    if (!Number.isFinite(value)) continue;
    if (Number.isNaN(previous) || value < previous) {
      const start = (series.times[i] as number) - value;
      const last = laps[laps.length - 1];
      if (last) last.duration = start - last.start;
      const named = lapNumber?.[i] ?? Number.NaN;
      laps.push({
        number: Number.isFinite(named) ? named : (last?.number ?? 0) + 1,
        start,
        duration: Number.NaN,
      });
    }
    previous = value;
  }
  return laps;
}

/** Index of the lap running at a timeline time, -1 before the first lap. */
export function lapIndexAt(laps: readonly Lap[], time: number): number {
  let index = -1;
  for (let i = 0; i < laps.length && (laps[i] as Lap).start <= time; i++) index = i;
  return index;
}

/** Whether a lap had finished at a timeline time. */
export function lapFinished(lap: Lap, time: number): boolean {
  return Number.isFinite(lap.duration) && lap.start + lap.duration <= time;
}

/** Shortest duration of the laps finished at a time (all finished laps by default), NaN when none. */
export function bestLapTime(laps: readonly Lap[], time = Number.POSITIVE_INFINITY): number {
  let best = Number.NaN;
  for (const lap of laps) {
    if (lapFinished(lap, time) && (Number.isNaN(best) || lap.duration < best)) best = lap.duration;
  }
  return best;
}

/** Signed lap time difference, `+0.123` / `-1.050`. */
export function formatDelta(seconds: number, decimals = 3, fallback = ''): string {
  if (!Number.isFinite(seconds)) return fallback;
  const rounded = Number(seconds.toFixed(decimals));
  return `${rounded < 0 ? '-' : '+'}${Math.abs(rounded).toFixed(decimals)}`;
}
