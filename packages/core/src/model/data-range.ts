import { z } from 'zod';

/**
 * The part of the session the data comes from (e.g. from lap 2, or until 2 laps before the end).
 * Outside it values have no data; inside it the session starts over: distance from 0, laps
 * numbered from 1, best lap of the kept laps only.
 */

/** One end of a data range: a timeline time, or a lap boundary. */
export const DataBoundSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('time'), time: z.number() }),
  z.object({
    kind: z.literal('lap'),
    /** 1 = the first lap of the session (or, with `fromEnd`, the last completed lap). */
    lap: z.number().int().min(1),
    /** Count the laps back from the last completed one. */
    fromEnd: z.boolean().default(false),
  }),
]);

/** Start / end of the data; null bounds are open (the whole session on that side). */
export const DataRangeSchema = z.object({
  /** A lap bound starts at the beginning of that lap. */
  start: DataBoundSchema.nullable().default(null),
  /** A lap bound ends at the end of that lap. */
  end: DataBoundSchema.nullable().default(null),
});

export type DataBound = z.infer<typeof DataBoundSchema>;
export type DataRange = z.infer<typeof DataRangeSchema>;

/** A data range in timeline seconds (infinite when open). */
export interface ResolvedDataRange {
  start: number;
  end: number;
}

export const FULL_DATA_RANGE: ResolvedDataRange = {
  start: Number.NEGATIVE_INFINITY,
  end: Number.POSITIVE_INFINITY,
};

export interface DataRangeLap {
  start: number;
  /** NaN while unfinished. */
  duration: number;
}

export type DataRangeProblem =
  | { code: 'lapMissing'; bound: 'start' | 'end'; lap: number; fromEnd: boolean }
  | { code: 'empty' };

/** Whether a range has a bound at all. */
export function hasDataBounds(range: DataRange | null | undefined): boolean {
  return Boolean(range && (range.start || range.end));
}

/** Whether a range has a lap bound (needs the laps to resolve). */
export function usesLaps(range: DataRange | null | undefined): boolean {
  return range?.start?.kind === 'lap' || range?.end?.kind === 'lap';
}

/**
 * Timeline times of a range, from the session's laps (in order). A lap bound that does not exist
 * (lap 9 of 6) is reported and left open.
 */
export function resolveDataRange(
  range: DataRange,
  laps: readonly DataRangeLap[],
): { range: ResolvedDataRange; problems: DataRangeProblem[] } {
  const problems: DataRangeProblem[] = [];
  const completed = laps.filter((lap) => Number.isFinite(lap.duration));
  const pick = (bound: DataBound & { kind: 'lap' }, which: 'start' | 'end') => {
    const lap = bound.fromEnd ? completed[completed.length - bound.lap] : laps[bound.lap - 1];
    const time = lap ? (which === 'start' ? lap.start : lap.start + lap.duration) : Number.NaN;
    if (!Number.isFinite(time)) {
      problems.push({ code: 'lapMissing', bound: which, lap: bound.lap, fromEnd: bound.fromEnd });
    }
    return time;
  };
  const time = (bound: DataBound | null, which: 'start' | 'end', open: number) => {
    if (!bound) return open;
    const value = bound.kind === 'time' ? bound.time : pick(bound, which);
    return Number.isFinite(value) ? value : open;
  };
  const resolved = {
    start: time(range.start, 'start', Number.NEGATIVE_INFINITY),
    end: time(range.end, 'end', Number.POSITIVE_INFINITY),
  };
  if (!(resolved.end > resolved.start)) problems.push({ code: 'empty' });
  return { range: resolved, problems };
}

/** Whether a time is inside a resolved range (end excluded). */
export function inDataRange(range: ResolvedDataRange, time: number): boolean {
  return time >= range.start && time < range.end;
}

/** A stable key of a range, to reuse values computed for it. */
export function dataRangeKey(range: DataRange | null | undefined): string {
  return hasDataBounds(range) ? JSON.stringify(range) : '';
}
