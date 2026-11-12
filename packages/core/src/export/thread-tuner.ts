/**
 * Finds how many threads should draw an export's frames on this machine, while it runs: no fixed
 * count suits every CPU, GPU and project, and what else the computer does changes it too. It
 * tries one thread more while drawing holds the export back, and one fewer while ffmpeg does,
 * keeps a change only when the measured speed says so, and leaves a count that did not pay off
 * alone for a while before trying it again.
 */

export interface TunerLimits {
  /** Fewest threads (at least 1). */
  min: number;
  /** Most threads: what the CPU cores and the free memory allow. */
  max: number;
}

/** What the export did over one measuring window. */
export interface TunerWindow {
  /** Frames per second over the window. */
  fps: number;
  /** What held the export back over the window, if anything. */
  waitingOn: 'drawing' | 'encoder' | null;
}

export type TunerDecision = 'add' | 'remove' | 'hold';

/** A change only counts as faster past this gain (measurements wobble by a few percent). */
const GAIN = 1.05;
/** A thread less may cost this much speed and still be kept (it frees a core for ffmpeg). */
const TOLERATED_LOSS = 0.97;
/** Windows a count that did not pay off is left alone before it is tried again. */
const RETRY_AFTER_WINDOWS = 10;

export class ThreadTuner {
  private threads: number;
  private readonly min: number;
  private readonly max: number;
  /** Counts not to try for now: above `ceiling`, below `floor`. */
  private ceiling: number;
  private floor: number;
  private windowsSinceBlocked = 0;
  /** The change being tried and the speed before it. */
  private trial: { change: 'add' | 'remove'; before: number } | null = null;

  constructor(start: number, limits: TunerLimits) {
    this.min = Math.max(1, limits.min);
    this.max = Math.max(this.min, limits.max);
    this.floor = this.min;
    this.ceiling = this.max;
    this.threads = Math.min(this.max, Math.max(this.min, start));
  }

  /** Threads the tuner wants now. */
  get count(): number {
    return this.threads;
  }

  /**
   * Feed the window measured since the last change took effect; returns the change to make
   * (the caller adds or removes one thread, then measures a new window once it is drawing).
   */
  next(window: TunerWindow): TunerDecision {
    if (this.trial) {
      const { change, before } = this.trial;
      this.trial = null;
      if (change === 'add') {
        if (window.fps >= before * GAIN) return 'hold';
        // No faster: back to one fewer, and no tries above it for a while.
        this.threads--;
        this.ceiling = this.threads;
        this.windowsSinceBlocked = 0;
        return 'remove';
      }
      if (window.fps >= before * TOLERATED_LOSS) return 'hold';
      // Slower without it: back, and no tries below for a while.
      this.threads++;
      this.floor = this.threads;
      this.windowsSinceBlocked = 0;
      return 'add';
    }
    if (++this.windowsSinceBlocked >= RETRY_AFTER_WINDOWS) {
      this.ceiling = this.max;
      this.floor = this.min;
    }
    if (window.waitingOn === 'drawing' && this.threads < this.ceiling) {
      this.trial = { change: 'add', before: window.fps };
      this.threads++;
      return 'add';
    }
    if (window.waitingOn === 'encoder' && this.threads > this.floor) {
      this.trial = { change: 'remove', before: window.fps };
      this.threads--;
      return 'remove';
    }
    return 'hold';
  }
}
