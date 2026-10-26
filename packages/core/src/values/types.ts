import type { ResolvedDataRange } from '../model/data-range.js';

/** Where a value comes from. */
export type ValueOrigin = 'source' | 'builtin' | 'script';

/** Description of a value available to widgets and scripts. */
export interface ValueInfo {
  id: string;
  /** Human name. */
  name: string;
  /** Human description. */
  description: string;
  unit: string;
  /** Used for frames without a value; null leaves them empty. */
  initial: number | null;
  origin: ValueOrigin;
  /** Set when this value replaces another one with the same id. */
  overrides?: ValueOrigin;
}

/** Source samples on the timeline (not resampled). */
export interface RawSamples {
  /** Timeline seconds, ascending. */
  time: Float64Array;
  values: Float64Array;
}

/** Frames a value is computed for. */
export interface FrameGrid {
  /** Timeline time of frame 0. */
  start: number;
  frameRate: number;
  count: number;
  /** Timeline time of each frame. */
  times: Float64Array;
}

/**
 * What a value script receives as `ctx`. Values are arrays with one number per frame; NaN means
 * "no value at this frame".
 */
export interface ValueContext {
  readonly frameCount: number;
  readonly frameRate: number;
  /** Timeline time of frame 0, in seconds. */
  readonly start: number;
  /** Timeline time of each frame, in seconds. */
  readonly times: Float64Array;
  /** UTC epoch milliseconds of timeline time 0, when known. */
  readonly startEpochMs: number | null;
  /**
   * The data range in timeline seconds (infinite bounds when open). Values are empty outside it;
   * builtins restart inside it (distance from 0, laps from 1).
   */
  readonly range: ResolvedDataRange;
  /** Per frame values of another value (a copy: free to modify). Throws for unknown ids. */
  get(id: string): Float64Array;
  has(id: string): boolean;
  /** Description of a value, undefined for unknown ids. */
  info(id: string): ValueInfo | undefined;
  /** Original source samples of a source value on the timeline, null for computed values. */
  raw(id: string): RawSamples | null;
}

/** What a value computation may return: an array with one entry per frame, or a constant. */
export type ValueOutput =
  | ArrayLike<number | null | undefined | boolean>
  | number
  | boolean
  | null
  | undefined;
