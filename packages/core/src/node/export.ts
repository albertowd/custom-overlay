import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, stat, statfs } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { availableParallelism, constants, freemem, getPriority, setPriority, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { defaultOutputPath, numberedPath } from '../export/output.js';
import {
  type CompositePipeline,
  cudaPipelineBlocker,
  type ExportCommand,
  encoderCandidates,
  encoderPixelFormat,
  estimateExportBytes,
  exportRange,
  imageSequenceCommand,
  parseDecodedRange,
  type VideoEncoder,
  videoExportCommand,
} from '../export/plan.js';
import { ThreadTuner, type TunerLimits } from '../export/thread-tuner.js';
import { yuva420pSize } from '../export/yuv.js';
import type { Project, Template } from '../model/project.js';
import { ProjectValues } from '../values/ranged.js';
import { enabledVideos, type ProjectMedia } from '../workflow/timeline.js';
import { DiskGuard, moveFile } from './disk-guard.js';
import {
  createFrameRenderer,
  type FramePixelFormat,
  type FrameRendererInit,
  type RenderedFrame,
} from './export-render.js';
import type { ExportWorkerRequest, ExportWorkerResponse } from './export-worker.js';

export interface ExportProgress {
  frame: number;
  frames: number;
  /** Frames per second so far. */
  fps: number;
  elapsedSeconds: number;
  /** Estimated seconds left, NaN at the start. */
  etaSeconds: number;
  /** `move` once the video is encoded and moved from the temporary folder to its place. */
  phase?: 'render' | 'move';
  /** Frames are slowed down for a slow disk (see `DiskSettings`). */
  throttled?: boolean;
  /**
   * What held the export back lately: drawing the widgets, or ffmpeg taking the frames
   * (decoding, encoding or the disk); null when neither did much.
   */
  waitingOn?: 'drawing' | 'encoder' | null;
  /** Threads drawing the frames now (the export tunes how many); 0 = the calling thread. */
  threads?: number;
}

export interface ExportOptions {
  project: Project;
  media: ProjectMedia;
  /** The template to draw (resolved from `templatePath` by the caller); the project's by default. */
  template?: Template;
  /** ffmpeg executable; `FFMPEG_PATH`, then the bundled `ffmpeg-static` by default. */
  ffmpegPath?: string;
  signal?: AbortSignal;
  onProgress?(progress: ExportProgress): void;
  /** UTC offset (minutes) for clock widgets; this machine's by default. */
  utcOffsetMinutes?: number;
  /** Threads drawing frames; 0 draws in this thread. A share of the CPU cores by default. */
  workers?: number;
  /**
   * Where ffmpeg blends the widgets: `auto` uses the NVIDIA GPU (CUDA) when the encoder is
   * NVIDIA's, the project allows it and it works on this machine; `cpu` never does.
   */
  pipeline?: 'auto' | 'cpu';
  /** Starts an export worker thread (bundled apps pass their own entry file). */
  createWorker?(): Worker;
  /**
   * Run this process (the drawing threads) and ffmpeg above the normal priority while exporting,
   * so the system keeps them on its fast cores; true by default.
   */
  raisePriority?: boolean;
}

export interface ExportResult {
  outputPath: string;
  frames: number;
  seconds: number;
  /** Video encoder used (null for image sequences). */
  encoder: string | null;
  /** Threads that drew the frames (0 = the calling thread). */
  workers: number;
  /** Where the widgets were blended on the video (`cpu` for image sequences). */
  pipeline: CompositePipeline;
  /** Widget errors met while drawing (first occurrence of each). */
  warnings: string[];
}

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

/** The ffmpeg to run: an explicit path, `FFMPEG_PATH`, or the bundled one. */
export function resolveFfmpegPath(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const bundled = createRequire(import.meta.url)('ffmpeg-static') as string | null;
  if (!bundled) throw new ExportError('No ffmpeg for this platform: set FFMPEG_PATH');
  // Packaged Electron apps keep executables outside the asar archive.
  return bundled.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

const workingEncoders = new Map<string, Promise<boolean>>();

/** Whether an encoder works on this machine (a GPU encoder needs a matching GPU and driver). */
export function encoderWorks(ffmpeg: string, encoder: VideoEncoder, bitDepth: 8 | 10): Promise<boolean> {
  const key = `${ffmpeg}|${encoder.name}|${bitDepth}`;
  let result = workingEncoders.get(key);
  if (!result) {
    result = new Promise((resolve) => {
      const args = [
        ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x144:r=30'],
        ...['-frames:v', '3', '-pix_fmt', encoderPixelFormat(encoder, bitDepth)],
        ...['-c:v', encoder.name, '-f', 'null', '-'],
      ];
      execFile(ffmpeg, args, { timeout: 15_000, windowsHide: true }, (error) => resolve(!error));
    });
    workingEncoders.set(key, result);
  }
  return result;
}

/** The first working encoder for the project's codec and acceleration setting. */
export async function chooseEncoder(ffmpeg: string, project: Project): Promise<VideoEncoder> {
  const { codec, acceleration } = project.export.encoder;
  const bitDepth = project.output.color.bitDepth;
  for (const candidate of encoderCandidates(codec, acceleration, bitDepth)) {
    if (await encoderWorks(ffmpeg, candidate, bitDepth)) return candidate;
  }
  throw new ExportError(`No working ${codec.toUpperCase()} encoder in ${ffmpeg}`);
}

/**
 * GPU decoding method of this platform. On Windows `auto` picks a slower path than D3D11 (4K
 * HEVC: 29 s instead of 22 s for 10 s); ffmpeg falls back to the CPU when it fails.
 */
export function hardwareDecoder(): string {
  if (process.platform === 'win32') return 'd3d11va';
  if (process.platform === 'darwin') return 'videotoolbox';
  return 'auto';
}

const decodedRanges = new Map<string, Promise<'tv' | 'pc'>>();

/** Range ffmpeg decodes a video file in (see `parseDecodedRange`), asked once per file. */
export function decodedRange(ffmpeg: string, path: string): Promise<'tv' | 'pc'> {
  let result = decodedRanges.get(path);
  if (!result) {
    result = new Promise((resolve) => {
      // Without an output ffmpeg describes the input and exits with an error: expected.
      execFile(
        ffmpeg,
        ['-hide_banner', '-i', path],
        { timeout: 15_000, windowsHide: true },
        (_e, _out, err) => resolve(parseDecodedRange(String(err)) ?? 'tv'),
      );
    });
    decodedRanges.set(path, result);
  }
  return result;
}

const workingCuda = new Map<string, Promise<boolean>>();

/**
 * Whether this ffmpeg can run the CUDA pipeline here: an NVIDIA GPU and driver, and a build with
 * the CUDA filters (checked once per ffmpeg).
 */
export function cudaPipelineWorks(ffmpeg: string): Promise<boolean> {
  let result = workingCuda.get(ffmpeg);
  if (!result) {
    result = new Promise((resolve) => {
      const args = [
        ...['-hide_banner', '-loglevel', 'error'],
        ...['-f', 'lavfi', '-i', 'color=c=black:s=256x144:r=30,format=yuv420p'],
        ...['-f', 'lavfi', '-i', 'color=c=black@0:s=256x144:r=30,format=yuva420p'],
        '-filter_complex',
        '[0:v]setparams=range=tv,hwupload_cuda,colorspace_cuda=range=tv,scale_cuda=format=yuv420p[b];[1:v]hwupload_cuda[w];[b][w]overlay_cuda[v]',
        ...['-map', '[v]', '-frames:v', '3', '-c:v', 'h264_nvenc', '-f', 'null', '-'],
      ];
      execFile(ffmpeg, args, { timeout: 15_000, windowsHide: true }, (error) => resolve(!error));
    });
    workingCuda.set(ffmpeg, result);
  }
  return result;
}

/**
 * Drawing threads an export starts with when it tunes their number itself: a safe start, not a
 * guess at the best count (see `ThreadTuner`).
 */
const START_THREADS = 2;

/** Share of the free memory more drawing threads may take (each holds the project's data). */
const THREAD_MEMORY_SHARE = 0.5;

/** Share of the free memory the frames drawn ahead of ffmpeg may take. */
const FRAMES_MEMORY_SHARE = 0.1;

/** How long the export runs between two thread count changes, to measure its speed. */
const TUNING_WINDOW_MS = 3000;

/**
 * How many more drawing threads the free memory allows, from what the first `threads` took
 * (`rssBefore`: the process before they started).
 */
function threadsMemoryAllows(rssBefore: number, threads: number): number {
  if (threads <= 0) return 0;
  const each = Math.max(1, (process.memoryUsage().rss - rssBefore) / threads);
  return Math.max(0, Math.floor((freemem() * THREAD_MEMORY_SHARE) / each));
}

/**
 * Applies a `ThreadTuner` to an export: measures the speed and what held it back over windows of
 * written frames, and adds or removes a drawing thread when the tuner says so.
 */
class TunedThreads {
  private readonly tuner: ThreadTuner;
  private changing = false;
  private stopped = false;
  private windowStart = performance.now();
  private frames = 0;
  private drawWait = 0;
  private encodeWait = 0;

  constructor(
    private readonly source: Required<FrameSource>,
    limits: TunerLimits,
  ) {
    this.tuner = new ThreadTuner(source.threads, limits);
  }

  /** A frame was written, after waiting `drawMs` for it to be drawn and `encodeMs` for ffmpeg. */
  frameWritten(drawMs: number, encodeMs: number): void {
    if (this.stopped || this.changing) return;
    this.frames++;
    this.drawWait += drawMs;
    this.encodeWait += encodeMs;
    const span = performance.now() - this.windowStart;
    if (span < TUNING_WINDOW_MS) return;
    const longest = Math.max(this.drawWait, this.encodeWait);
    const waitingOn =
      longest < span * WAIT_SHARE ? null : this.drawWait >= this.encodeWait ? 'drawing' : 'encoder';
    const decision = this.tuner.next({ fps: (this.frames * 1000) / span, waitingOn });
    if (decision === 'add') {
      this.changing = true;
      this.source
        .add()
        .catch(() => {
          // A thread that cannot start (memory, a crash): keep the ones there are.
          this.stopped = true;
        })
        .finally(() => {
          this.changing = false;
          this.restart();
        });
      return;
    }
    if (decision === 'remove') this.source.remove();
    this.restart();
  }

  private restart(): void {
    this.windowStart = performance.now();
    this.frames = 0;
    this.drawWait = 0;
    this.encodeWait = 0;
  }
}

/** An export worker thread from this package's entry file. */
export function createExportWorker(): Worker {
  return new Worker(new URL('./export-worker-entry.js', import.meta.url));
}

/** Draws frames; `frame(n)` resolves with frame n's pixels. */
interface FrameSource {
  frame(n: number): Promise<RenderedFrame>;
  close(): Promise<void>;
  /** Threads drawing now (0 = the calling thread). */
  readonly threads: number;
  /** Start one more thread; resolves once it draws. */
  add?(): Promise<void>;
  /** Stop a thread once it has drawn the frames it was given. */
  remove?(): void;
}

interface WorkerSlot {
  worker: Worker;
  waiting: Map<number, { resolve(f: RenderedFrame): void; reject(e: Error): void }>;
  ready: boolean;
  /** Gets no new frames; stopped once its frames are drawn. */
  retiring: boolean;
}

/** Drawing threads that can be added and removed while frames are drawn. */
class WorkerPool implements FrameSource {
  private readonly slots: WorkerSlot[] = [];

  constructor(
    private readonly init: FrameRendererInit,
    private readonly pixelFormat: FramePixelFormat,
    private readonly create: () => Worker,
  ) {}

  get threads(): number {
    return this.slots.filter((s) => s.ready && !s.retiring).length;
  }

  add(): Promise<void> {
    const slot: WorkerSlot = { worker: this.create(), waiting: new Map(), ready: false, retiring: false };
    this.slots.push(slot);
    return new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        reject(error);
        for (const pending of slot.waiting.values()) pending.reject(error);
        slot.waiting.clear();
        this.drop(slot);
      };
      slot.worker.on('error', fail);
      slot.worker.on('exit', (code) => {
        if (code !== 0 && !slot.retiring) fail(new ExportError(`Export worker stopped (code ${code})`));
      });
      slot.worker.on('message', (message: ExportWorkerResponse) => {
        if (message.type === 'ready') {
          slot.ready = true;
          resolve();
        } else if (message.type === 'error') {
          fail(new ExportError(message.message));
        } else {
          slot.waiting.get(message.frame)?.resolve({ pixels: message.pixels, warnings: message.warnings });
          slot.waiting.delete(message.frame);
          if (slot.retiring && slot.waiting.size === 0) this.drop(slot);
        }
      });
      slot.worker.postMessage({
        type: 'init',
        init: this.init,
        pixelFormat: this.pixelFormat,
      } satisfies ExportWorkerRequest);
    });
  }

  remove(): void {
    const drawing = this.slots.filter((s) => s.ready && !s.retiring);
    if (drawing.length <= 1) return;
    // The thread with the fewest frames to finish.
    const slot = drawing.reduce((a, b) => (b.waiting.size < a.waiting.size ? b : a));
    slot.retiring = true;
    if (slot.waiting.size === 0) this.drop(slot);
  }

  frame(n: number): Promise<RenderedFrame> {
    const drawing = this.slots.filter((s) => s.ready && !s.retiring);
    if (drawing.length === 0) return Promise.reject(new ExportError('No export worker is drawing'));
    // The least busy thread, so a new or faster one gets more.
    const slot = drawing.reduce((a, b) => (b.waiting.size < a.waiting.size ? b : a));
    return new Promise((resolve, reject) => {
      slot.waiting.set(n, { resolve, reject });
      slot.worker.postMessage({ type: 'frame', frame: n } satisfies ExportWorkerRequest);
    });
  }

  async close(): Promise<void> {
    const slots = this.slots.splice(0);
    for (const slot of slots) slot.retiring = true;
    await Promise.all(slots.map((s) => s.worker.terminate()));
  }

  private drop(slot: WorkerSlot): void {
    const at = this.slots.indexOf(slot);
    if (at >= 0) this.slots.splice(at, 1);
    slot.retiring = true;
    void slot.worker.terminate();
  }
}

/**
 * The drawing threads: `count` of them (0 draws in this thread), or by default a few to start
 * with, which the export then tunes. Falls back to this thread when threads cannot start (e.g. a
 * bundle without the worker entry file).
 */
async function frameSource(
  init: FrameRendererInit,
  pixelFormat: FramePixelFormat,
  count: number,
  options: ExportOptions,
): Promise<FrameSource> {
  if (count > 0) {
    const pool = new WorkerPool(init, pixelFormat, options.createWorker ?? createExportWorker);
    try {
      await Promise.all(Array.from({ length: count }, () => pool.add()));
      return pool;
    } catch {
      await pool.close();
    }
  }
  const renderer = await createFrameRenderer(init, pixelFormat);
  return { threads: 0, frame: async (n) => renderer.render(n), close: async () => undefined };
}

/** `path`, or the first free `path (2)`, `path (3)`... (a folder counts as taken when not empty). */
async function unusedPath(path: string, file: boolean): Promise<string> {
  const taken = async (candidate: string) => {
    if (file) return (await stat(candidate).catch(() => null)) !== null;
    return ((await readdir(candidate).catch(() => [])) as string[]).length > 0;
  };
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? path : numberedPath(path, n, file);
    if (!(await taken(candidate))) return candidate;
  }
}

/** Bytes that make a size readable in an error message. */
function gigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/**
 * A folder in the system's temporary folder to write the video to before moving it, checking it
 * has room for it (with a margin).
 */
async function stagingFolder(project: Project, seconds: number): Promise<string> {
  const needed = estimateExportBytes(project.export.encoder, seconds) * 1.2;
  const space = await statfs(tmpdir()).catch(() => null);
  const free = space ? space.bavail * space.bsize : Number.POSITIVE_INFINITY;
  if (free < needed) {
    throw new ExportError(
      `Not enough space in the temporary folder ${tmpdir()} (${gigabytes(free)} free, about ${gigabytes(needed)} needed)`,
    );
  }
  return mkdtemp(join(tmpdir(), 'custom-overlay-'));
}

/**
 * Raise a process to above normal priority, returning how to put it back. Windows keeps windowless
 * background work on the efficiency cores of hybrid CPUs otherwise. Not allowed (Linux without
 * privileges): nothing changes.
 */
function raisePriority(pid: number): () => void {
  try {
    const before = getPriority(pid);
    if (before <= constants.priority.PRIORITY_ABOVE_NORMAL) return () => undefined;
    setPriority(pid, constants.priority.PRIORITY_ABOVE_NORMAL);
    return () => {
      try {
        setPriority(pid, before);
      } catch {
        // The process may be gone.
      }
    };
  } catch {
    return () => undefined;
  }
}

/** Share of a report interval a wait must take to count as what holds the export back. */
const WAIT_SHARE = 0.25;

/**
 * Size of the pieces a frame is written to ffmpeg in. One write of a whole 4K frame (20-33 MB)
 * into a Windows pipe can fail ("write UNKNOWN", or a crash in libuv) when the system runs short
 * of memory it can lock for the write, which the CUDA driver also uses.
 */
const PIPE_WRITE_BYTES = 1 << 20;

/** Queue a frame for ffmpeg in pieces (views of it, not copies); false when the pipe is full. */
function writeFrame(stdin: NodeJS.WritableStream, pixels: Uint8Array): boolean {
  const bytes = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  let open = true;
  for (let at = 0; at < bytes.byteLength; at += PIPE_WRITE_BYTES) {
    open = stdin.write(bytes.subarray(at, at + PIPE_WRITE_BYTES));
  }
  return open;
}

/** Last lines of ffmpeg's error output. */
function tail(text: string, lines = 8): string {
  return text.trim().split(/\r?\n/).slice(-lines).join('\n');
}

/**
 * Render the export of a project: the final video with the widgets burned in, or a transparent
 * PNG sequence of the widgets. Frames are drawn on worker threads (Skia canvas, the editor's
 * widget code) and piped in order to ffmpeg, which cuts, scales and encodes the videos.
 */
export async function exportProject(options: ExportOptions): Promise<ExportResult> {
  const { project, media, signal } = options;
  const chosen = project.export.outputPath;
  const fallback = chosen ? null : defaultOutputPath(project);
  if (!chosen && !fallback) throw new ExportError('Choose an output location first');
  // The default location never replaces an earlier export: Race.mp4, then Race (2).mp4...
  const outputPath = chosen ?? (await unusedPath(fallback as string, project.export.mode === 'video'));
  const template = options.template ?? project.template;
  const ffmpeg = resolveFfmpegPath(options.ffmpegPath);
  const started = Date.now();
  // Open range bounds follow the data range of the Track step, like the export step shows.
  const dataRange = new ProjectValues(project, media).resolve(project.dataRange).range;

  const disk = project.export.disk;
  const range = exportRange(project, media, dataRange);
  let command: ExportCommand;
  let encoder: VideoEncoder | null = null;
  // With staging the video is written to the temporary folder, then moved to `outputPath`.
  let staging: string | null = null;
  let writePath = outputPath;
  const removeStaging = async () => {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  };
  if (project.export.mode === 'video') {
    encoder = await chooseEncoder(ffmpeg, project);
    await mkdir(dirname(outputPath), { recursive: true });
    if (disk.stageInTemp) {
      staging = await stagingFolder(project, range.end - range.start);
      writePath = join(staging, basename(outputPath));
    }
    const pipeline: CompositePipeline =
      options.pipeline !== 'cpu' &&
      cudaPipelineBlocker({ project, media, encoder, dataRange }) === null &&
      (await cudaPipelineWorks(ffmpeg))
        ? 'cuda'
        : 'cpu';
    // The CUDA filters need each video's range spelled out, as ffmpeg decodes it.
    const videoRanges: Record<string, 'tv' | 'pc'> = {};
    if (pipeline === 'cuda') {
      for (const video of enabledVideos(project)) {
        const path = media.videos[video.id]?.path;
        if (path) videoRanges[path] = await decodedRange(ffmpeg, path);
      }
    }
    command = videoExportCommand({
      project,
      media,
      outputPath: writePath,
      encoder,
      hardwareDecode: project.export.encoder.acceleration === 'software' ? null : hardwareDecoder(),
      dataRange,
      pipeline,
      videoRanges,
    });
  } else {
    await mkdir(outputPath, { recursive: true });
    command = imageSequenceCommand({
      project,
      media,
      pattern: join(outputPath, 'frame_%06d.png'),
      dataRange,
    });
  }
  const { width, height, frameRate, frames } = command;
  if (frames === 0) {
    await removeStaging();
    throw new ExportError('The export range is empty');
  }
  // The CUDA pipeline takes the widgets already converted to the output's colours.
  const color = project.output.color;
  const pixelFormat: FramePixelFormat =
    command.overlayFormat === 'yuva420p'
      ? {
          format: 'yuva420p',
          matrix: color.space === 'rec709' ? 'bt709' : 'bt2020',
          range: color.range === 'full' ? 'pc' : 'tv',
        }
      : { format: 'rgba' };

  const rssBefore = process.memoryUsage().rss;
  const source = await frameSource(
    {
      project,
      media,
      template,
      palette: project.palette,
      width,
      height,
      frameRate,
      start: range.start,
      utcOffsetMinutes: options.utcOffsetMinutes,
    },
    pixelFormat,
    options.workers ?? START_THREADS,
    options,
  ).catch(async (error: unknown) => {
    await removeStaging();
    throw error;
  });
  // Without a set count, the export finds how many threads draw best on this machine.
  const tuning =
    options.workers === undefined && source.add && source.remove
      ? new TunedThreads(source as Required<FrameSource>, {
          min: 1,
          max: Math.min(
            availableParallelism() - 1,
            source.threads + threadsMemoryAllows(rssBefore, source.threads),
          ),
        })
      : null;

  const guard = new DiskGuard({
    slow: disk.slow,
    maxSpeed: disk.maxSpeed,
    frameRate,
    outputPath: project.export.mode === 'video' ? writePath : null,
    probePaths: enabledVideos(project).flatMap((video) => {
      const path = media.videos[video.id]?.path;
      return path ? [path] : [];
    }),
  });
  if (guard.active) await guard.start();

  const child: ChildProcess = spawn(ffmpeg, command.args, {
    stdio: ['pipe', 'ignore', 'pipe'],
    windowsHide: true,
  });
  const restorePriority =
    options.raisePriority === false
      ? () => undefined
      : (() => {
          const own = raisePriority(process.pid);
          if (child.pid !== undefined) raisePriority(child.pid);
          return own;
        })();
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-16_000);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  const stdin = child.stdin;
  if (!stdin) throw new ExportError('Could not start ffmpeg');
  // ffmpeg closing its input early (an error) must not crash the process.
  stdin.on('error', () => undefined);

  // A plain kill (SIGTERM on Linux and macOS) asks ffmpeg to finish cleanly, which can leave it
  // waiting forever on the open frame pipe: close the pipe and stop it for good.
  const stop = () => {
    stdin.destroy();
    child.kill('SIGKILL');
  };
  signal?.addEventListener('abort', stop, { once: true });
  const warnings = new Set<string>();
  const { acceleration } = project.export.encoder;
  if (encoder && !encoder.hardware && acceleration !== 'auto' && acceleration !== 'software') {
    warnings.add(`No working ${acceleration.toUpperCase()} encoder for this format: encoded on the CPU`);
  }
  // Frames requested ahead, so every thread stays busy while frames are written in order; at
  // most what a share of the free memory holds (a 4K frame is 20-33 MB).
  const frameBytes = command.overlayFormat === 'yuva420p' ? yuva420pSize(width, height) : width * height * 4;
  const mostAhead = Math.max(2, Math.floor((freemem() * FRAMES_MEMORY_SHARE) / frameBytes));
  const requested = new Map<number, Promise<RenderedFrame>>();
  let threadsUsed = source.threads;
  let scheduled = 0;
  let lastReport = 0;
  // Milliseconds spent waiting for drawn frames and for ffmpeg to take them, since the last report.
  let drawWait = 0;
  let encodeWait = 0;
  let windowStart = performance.now();
  try {
    for (let n = 0; n < frames; n++) {
      if (signal?.aborted) throw new ExportError('Export cancelled');
      if (child.exitCode !== null) break;
      const ahead = Math.min(mostAhead, Math.max(2, source.threads * 3));
      while (scheduled < frames && scheduled < n + ahead) {
        requested.set(scheduled, source.frame(scheduled));
        scheduled++;
      }
      const waitStarted = performance.now();
      const frame = await requested.get(n);
      const drew = performance.now() - waitStarted;
      drawWait += drew;
      requested.delete(n);
      if (!frame) break;
      for (const warning of frame.warnings) warnings.add(warning);
      let encoded = 0;
      if (!writeFrame(stdin, frame.pixels)) {
        const drainStarted = performance.now();
        await Promise.race([once(stdin, 'drain'), exited]);
        encoded = performance.now() - drainStarted;
        encodeWait += encoded;
      }
      tuning?.frameWritten(drew, encoded);
      threadsUsed = source.threads;
      if (guard.active) await guard.pace(n);
      const now = Date.now();
      if (options.onProgress && (now - lastReport > 250 || n === frames - 1)) {
        lastReport = now;
        const elapsed = (now - started) / 1000;
        const fps = (n + 1) / Math.max(elapsed, 1e-3);
        const span = Math.max(1, performance.now() - windowStart);
        const longest = Math.max(drawWait, encodeWait);
        const waitingOn = longest < span * WAIT_SHARE ? null : drawWait >= encodeWait ? 'drawing' : 'encoder';
        drawWait = 0;
        encodeWait = 0;
        windowStart = performance.now();
        options.onProgress({
          frame: n + 1,
          frames,
          fps,
          elapsedSeconds: elapsed,
          etaSeconds: n > 10 ? (frames - n - 1) / fps : Number.NaN,
          phase: 'render',
          throttled: guard.status().throttled,
          waitingOn,
          threads: source.threads,
        });
      }
    }
    stdin.end();
    const code = await exited;
    if (signal?.aborted) throw new ExportError('Export cancelled');
    if (code !== 0) throw new ExportError(`ffmpeg failed (exit code ${code}):\n${tail(stderr)}`);
    await guard.close();
    if (staging) {
      const elapsed = (Date.now() - started) / 1000;
      options.onProgress?.({
        frame: frames,
        frames,
        fps: frames / Math.max(elapsed, 1e-3),
        elapsedSeconds: elapsed,
        etaSeconds: Number.NaN,
        phase: 'move',
        throttled: false,
      });
      // A failed or cancelled move leaves nothing at `outputPath` (an earlier file stays).
      await moveFile(writePath, outputPath, { slow: disk.slow, signal });
    }
  } catch (error) {
    // ffmpeg stopping on its own breaks the frame pipe: its error says why, not the pipe's.
    const ffmpegCode = child.exitCode;
    stop();
    await exited.catch(() => null);
    await guard.close();
    // Do not leave a broken video behind.
    if (project.export.mode === 'video') await rm(writePath, { force: true }).catch(() => undefined);
    // Killing ffmpeg breaks the pipe it reads frames from ("write EOF"): still a cancellation.
    if (signal?.aborted) throw new ExportError('Export cancelled');
    if (ffmpegCode !== null && ffmpegCode !== 0 && !(error instanceof ExportError)) {
      throw new ExportError(`ffmpeg failed (exit code ${ffmpegCode}):\n${tail(stderr)}`);
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', stop);
    restorePriority();
    // Pending frames resolve or fail with the workers; nothing waits for them any more.
    for (const pending of requested.values()) pending.catch(() => undefined);
    await guard.close();
    await source.close();
    await removeStaging();
  }
  return {
    outputPath,
    frames,
    seconds: (Date.now() - started) / 1000,
    encoder: encoder?.name ?? null,
    workers: threadsUsed,
    pipeline: command.pipeline,
    warnings: [...warnings],
  };
}
