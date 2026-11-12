import { type FileHandle, open, rename, rm } from 'node:fs/promises';

/**
 * Gentle disk use while exporting (see `DiskSettings`). A hard drive holding both the videos
 * being read and the video being written can stall when the operating system flushes a large
 * write cache at once: reads of the videos then wait for seconds and ffmpeg may fail. The guard
 *
 * - flushes the output file regularly, so the write cache never grows large;
 * - measures how fast the disk of the videos answers (small reads at random places of a video)
 *   and slows the frames down while it is slow, waiting for it to recover when it is very slow;
 * - caps the encoding speed when asked.
 */

/** Read latency below which a disk is never considered busy, in milliseconds. */
export const BUSY_LATENCY_FLOOR_MS = 120;
/** A busy disk answers this many times slower than when the export started (or the floor). */
const BUSY_FACTOR = 6;
/** Far slower than busy: frames stop until the disk recovers (at most `MAX_WAIT_MS`). */
const STALLED_FACTOR = 4;
const MAX_WAIT_MS = 10_000;
/** Delay added per frame while busy: starts here, grows by half each busy frame, up to the max. */
const MIN_DELAY_MS = 10;
const MAX_DELAY_MS = 500;
const PROBE_INTERVAL_MS = 500;
const FLUSH_INTERVAL_MS = 1000;
const PROBE_BYTES = 4096;

export interface DiskGuardOptions {
  /** Flush and slow down for the disk (otherwise only `maxSpeed` applies). */
  slow: boolean;
  /** Highest speed in × real time, 0 = no limit. */
  maxSpeed: number;
  /** Output frame rate, for the speed limit. */
  frameRate: number;
  /** File flushed to the disk regularly (the video being written), null for none. */
  outputPath: string | null;
  /** Files read to measure their disk's latency (the videos). */
  probePaths: readonly string[];
  /** Test hooks. */
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /** Milliseconds a small read of the file takes. */
  probe?(path: string): Promise<number>;
  /** Flush a file to the disk; resolves false when it does not exist (yet). */
  flush?(path: string): Promise<boolean>;
  /** Timers, started by `start`. */
  every?(ms: number, run: () => void): () => void;
}

export interface DiskStatus {
  /** Frames are slowed down for the disk. */
  throttled: boolean;
  /** Recent read latency of the videos' disk, NaN before the first measure. */
  latencyMs: number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function realEvery(ms: number, run: () => void): () => void {
  const timer = setInterval(run, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Small reads at random places of files, keeping them open. */
function fileProber(): { probe(path: string): Promise<number>; close(): Promise<void> } {
  const files = new Map<string, Promise<{ handle: FileHandle; size: number } | null>>();
  const buffer = Buffer.alloc(PROBE_BYTES);
  return {
    async probe(path) {
      let file = files.get(path);
      if (!file) {
        file = open(path, 'r')
          .then(async (handle) => ({ handle, size: (await handle.stat()).size }))
          .catch(() => null);
        files.set(path, file);
      }
      const opened = await file;
      if (!opened) return Number.NaN;
      const blocks = Math.max(1, Math.floor(opened.size / PROBE_BYTES) - 1);
      const position = Math.floor(Math.random() * blocks) * PROBE_BYTES;
      const started = performance.now();
      await opened.handle.read(buffer, 0, PROBE_BYTES, position);
      return performance.now() - started;
    },
    async close() {
      const opened = await Promise.all(files.values());
      files.clear();
      await Promise.all(opened.map((f) => f?.handle.close().catch(() => undefined)));
    },
  };
}

/** Flushes a file written by another process (its cache is shared), keeping it open. */
function fileFlusher(): { flush(path: string): Promise<boolean>; close(): Promise<void> } {
  let handle: FileHandle | null = null;
  return {
    async flush(path) {
      if (!handle) {
        // Writing access is needed to flush on Windows; ffmpeg shares it.
        handle = await open(path, 'r+').catch(() => null);
        if (!handle) return false;
      }
      await handle.sync();
      return true;
    },
    async close() {
      await handle?.close().catch(() => undefined);
      handle = null;
    },
  };
}

export class DiskGuard {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly prober = fileProber();
  private readonly flusher = fileFlusher();
  private stops: (() => void)[] = [];
  private started = 0;
  private baseline = Number.NaN;
  private latency = Number.NaN;
  /** Start of the probe in flight (its wait counts as latency already), NaN when none. */
  private probing = Number.NaN;
  private flushing = false;
  private next = 0;
  private delay = 0;
  private throttled = false;
  private closed = false;

  constructor(private readonly options: DiskGuardOptions) {
    this.now = options.now ?? (() => performance.now());
    this.sleep = options.sleep ?? realSleep;
  }

  /** Whether the guard does anything with these settings. */
  get active(): boolean {
    return this.options.slow || this.options.maxSpeed > 0;
  }

  /** Measure the idle latency, then start probing and flushing. */
  async start(): Promise<void> {
    this.started = this.now();
    if (!this.options.slow) return;
    const idle: number[] = [];
    for (let i = 0; i < 3 && this.options.probePaths.length > 0; i++) {
      const measured = await this.measure();
      if (Number.isFinite(measured)) idle.push(measured);
    }
    this.baseline = idle.length > 0 ? Math.min(...idle) : Number.NaN;
    this.latency = Number.NaN;
    const every = this.options.every ?? realEvery;
    if (this.options.probePaths.length > 0) {
      this.stops.push(every(PROBE_INTERVAL_MS, () => void this.measure()));
    }
    if (this.options.outputPath) this.stops.push(every(FLUSH_INTERVAL_MS, () => void this.flush()));
    // The encoding starts now: the speed limit counts from here.
    this.started = this.now();
  }

  status(): DiskStatus {
    return { throttled: this.throttled, latencyMs: this.currentLatency() };
  }

  /** Called after each frame is handed to the encoder: waits as long as the disk needs. */
  async pace(frame: number): Promise<void> {
    if (this.options.maxSpeed > 0 && this.options.frameRate > 0) {
      const due = this.started + ((frame + 1) / (this.options.frameRate * this.options.maxSpeed)) * 1000;
      const early = due - this.now();
      if (early > 1) await this.sleep(early);
    }
    if (!this.options.slow) return;
    const busy = this.busyLatency();
    let latency = this.currentLatency();
    if (latency > busy * STALLED_FACTOR) {
      // Nearly stalled: no new frames until the disk answers again (or for a while).
      const waitUntil = this.now() + MAX_WAIT_MS;
      while (latency > busy && this.now() < waitUntil) {
        await this.sleep(100);
        latency = this.currentLatency();
      }
    }
    if (latency > busy) {
      this.throttled = true;
      this.delay = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, this.delay * 1.5));
    } else if (this.delay > 0) {
      this.delay *= 0.8;
      if (this.delay < 1) {
        this.delay = 0;
        this.throttled = false;
      }
    }
    if (this.delay >= 1) await this.sleep(this.delay);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const stop of this.stops) stop();
    this.stops = [];
    // A last flush, so the end of the video is on the disk before it is moved or reported.
    if (this.options.slow && this.options.outputPath) await this.flush();
    await Promise.all([this.prober.close(), this.flusher.close()]);
  }

  /** Latency above which the disk is busy. */
  private busyLatency(): number {
    return Math.max(
      BUSY_LATENCY_FLOOR_MS,
      (Number.isFinite(this.baseline) ? this.baseline : 0) * BUSY_FACTOR,
    );
  }

  /** Recent latency, or the wait of the probe in flight when that is longer. */
  private currentLatency(): number {
    const waiting = Number.isNaN(this.probing) ? Number.NaN : this.now() - this.probing;
    if (Number.isNaN(this.latency)) return waiting;
    return Number.isNaN(waiting) ? this.latency : Math.max(this.latency, waiting);
  }

  private async measure(): Promise<number> {
    if (!Number.isNaN(this.probing)) return Number.NaN;
    const paths = this.options.probePaths;
    const path = paths[this.next++ % paths.length] as string;
    this.probing = this.now();
    let measured = Number.NaN;
    try {
      measured = await (this.options.probe ?? this.prober.probe)(path);
    } catch {
      // An unreadable file tells nothing about the disk.
    } finally {
      this.probing = Number.NaN;
    }
    if (Number.isFinite(measured)) {
      // Quick to rise, slower to fall.
      this.latency = Number.isNaN(this.latency)
        ? measured
        : measured > this.latency
          ? measured
          : this.latency * 0.6 + measured * 0.4;
    }
    return measured;
  }

  private async flush(): Promise<void> {
    const path = this.options.outputPath;
    if (!path || this.flushing) return;
    this.flushing = true;
    try {
      await (this.options.flush ?? this.flusher.flush)(path);
    } catch {
      // Flushing is a help, never a reason to fail the export.
    } finally {
      this.flushing = false;
    }
  }
}

const COPY_CHUNK = 8 * 1024 * 1024;
const COPY_FLUSH_EVERY = 64 * 1024 * 1024;

export interface MoveOptions {
  /** Flush the copy to the disk regularly. */
  slow?: boolean;
  signal?: AbortSignal;
  onProgress?(done: number, total: number): void;
}

/** Move a file; across disks it is copied (see `copyAndRemove`). */
export async function moveFile(from: string, to: string, options: MoveOptions = {}): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await copyAndRemove(from, to, options);
  }
}

/**
 * Copy a file in chunks (flushed to the disk regularly with `slow`), then remove it. A failed or
 * cancelled copy leaves no partial file behind.
 */
export async function copyAndRemove(from: string, to: string, options: MoveOptions = {}): Promise<void> {
  const source = await open(from, 'r');
  let target: FileHandle | null = null;
  try {
    target = await open(to, 'w');
    const total = (await source.stat()).size;
    const buffer = Buffer.alloc(COPY_CHUNK);
    let done = 0;
    let unflushed = 0;
    while (done < total) {
      if (options.signal?.aborted) throw new Error('Export cancelled');
      const { bytesRead } = await source.read(buffer, 0, COPY_CHUNK, done);
      if (bytesRead === 0) break;
      await target.write(buffer, 0, bytesRead, done);
      done += bytesRead;
      unflushed += bytesRead;
      if (options.slow && unflushed >= COPY_FLUSH_EVERY) {
        await target.sync();
        unflushed = 0;
      }
      options.onProgress?.(done, total);
    }
    await target.sync();
    await target.close();
    target = null;
  } catch (error) {
    await target?.close().catch(() => undefined);
    await rm(to, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await source.close();
  }
  await rm(from, { force: true });
}
