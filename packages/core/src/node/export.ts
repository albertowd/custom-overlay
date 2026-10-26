import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { defaultOutputPath, numberedPath } from '../export/output.js';
import {
  type ExportCommand,
  encoderCandidates,
  encoderPixelFormat,
  exportRange,
  imageSequenceCommand,
  type VideoEncoder,
  videoExportCommand,
} from '../export/plan.js';
import type { Project, Template } from '../model/project.js';
import { ProjectValues } from '../values/ranged.js';
import type { ProjectMedia } from '../workflow/timeline.js';
import { createFrameRenderer, type FrameRendererInit, type RenderedFrame } from './export-render.js';
import type { ExportWorkerRequest, ExportWorkerResponse } from './export-worker.js';

export interface ExportProgress {
  frame: number;
  frames: number;
  /** Frames per second so far. */
  fps: number;
  elapsedSeconds: number;
  /** Estimated seconds left, NaN at the start. */
  etaSeconds: number;
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
  /** Starts an export worker thread (bundled apps pass their own entry file). */
  createWorker?(): Worker;
}

export interface ExportResult {
  outputPath: string;
  frames: number;
  seconds: number;
  /** Video encoder used (null for image sequences). */
  encoder: string | null;
  /** Threads that drew the frames (0 = the calling thread). */
  workers: number;
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

/** Default number of drawing threads: a third of the cores (ffmpeg needs the rest), 1 to 6. */
export function defaultExportWorkers(): number {
  return Math.max(1, Math.min(6, Math.floor(availableParallelism() / 3)));
}

/** An export worker thread from this package's entry file. */
export function createExportWorker(): Worker {
  return new Worker(new URL('./export-worker-entry.js', import.meta.url));
}

/** Draws frames on worker threads; `frame(n)` resolves with frame n's pixels. */
interface FrameSource {
  frame(n: number): Promise<RenderedFrame>;
  close(): Promise<void>;
  threads: number;
}

async function workerFrameSource(
  init: FrameRendererInit,
  count: number,
  create: () => Worker,
): Promise<FrameSource> {
  const workers = Array.from({ length: count }, () => create());
  const waiting = workers.map(
    () => new Map<number, { resolve(f: RenderedFrame): void; reject(e: Error): void }>(),
  );
  const ready = workers.map(
    (worker, w) =>
      new Promise<void>((resolve, reject) => {
        const fail = (error: Error) => {
          reject(error);
          for (const pending of waiting[w]?.values() ?? []) pending.reject(error);
          waiting[w]?.clear();
        };
        worker.on('error', fail);
        worker.on(
          'exit',
          (code) => code !== 0 && fail(new ExportError(`Export worker stopped (code ${code})`)),
        );
        worker.on('message', (message: ExportWorkerResponse) => {
          if (message.type === 'ready') resolve();
          else if (message.type === 'error') fail(new ExportError(message.message));
          else {
            waiting[w]?.get(message.frame)?.resolve({ pixels: message.pixels, warnings: message.warnings });
            waiting[w]?.delete(message.frame);
          }
        });
        worker.postMessage({ type: 'init', init } satisfies ExportWorkerRequest);
      }),
  );
  try {
    await Promise.all(ready);
  } catch (error) {
    await Promise.all(workers.map((w) => w.terminate()));
    throw error;
  }
  return {
    threads: count,
    frame(n) {
      const w = n % count;
      return new Promise((resolve, reject) => {
        waiting[w]?.set(n, { resolve, reject });
        workers[w]?.postMessage({ type: 'frame', frame: n } satisfies ExportWorkerRequest);
      });
    },
    async close() {
      await Promise.all(workers.map((w) => w.terminate()));
    },
  };
}

async function frameSource(init: FrameRendererInit, options: ExportOptions): Promise<FrameSource> {
  const count = options.workers ?? defaultExportWorkers();
  if (count > 0) {
    try {
      return await workerFrameSource(init, count, options.createWorker ?? createExportWorker);
    } catch {
      // No worker threads here (e.g. a bundle without the entry file): draw in this thread.
    }
  }
  const renderer = await createFrameRenderer(init);
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

  let command: ExportCommand;
  let encoder: VideoEncoder | null = null;
  if (project.export.mode === 'video') {
    encoder = await chooseEncoder(ffmpeg, project);
    await mkdir(dirname(outputPath), { recursive: true });
    command = videoExportCommand({
      project,
      media,
      outputPath,
      encoder,
      hardwareDecode: project.export.encoder.acceleration === 'auto' ? hardwareDecoder() : null,
      dataRange,
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
  if (frames === 0) throw new ExportError('The export range is empty');

  const source = await frameSource(
    {
      project,
      media,
      template,
      palette: project.palette,
      width,
      height,
      frameRate,
      start: exportRange(project, media, dataRange).start,
      utcOffsetMinutes: options.utcOffsetMinutes,
    },
    options,
  );

  const child: ChildProcess = spawn(ffmpeg, command.args, {
    stdio: ['pipe', 'ignore', 'pipe'],
    windowsHide: true,
  });
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

  const abort = () => child.kill();
  signal?.addEventListener('abort', abort, { once: true });
  const warnings = new Set<string>();
  // Frames requested ahead, so every thread stays busy while frames are written in order.
  const ahead = Math.max(2, source.threads * 3);
  const requested = new Map<number, Promise<RenderedFrame>>();
  let scheduled = 0;
  let lastReport = 0;
  try {
    for (let n = 0; n < frames; n++) {
      if (signal?.aborted) throw new ExportError('Export cancelled');
      if (child.exitCode !== null) break;
      while (scheduled < frames && scheduled < n + ahead) {
        requested.set(scheduled, source.frame(scheduled));
        scheduled++;
      }
      const frame = await requested.get(n);
      requested.delete(n);
      if (!frame) break;
      for (const warning of frame.warnings) warnings.add(warning);
      const { pixels } = frame;
      if (!stdin.write(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength))) {
        await Promise.race([once(stdin, 'drain'), exited]);
      }
      const now = Date.now();
      if (options.onProgress && (now - lastReport > 250 || n === frames - 1)) {
        lastReport = now;
        const elapsed = (now - started) / 1000;
        const fps = (n + 1) / Math.max(elapsed, 1e-3);
        options.onProgress({
          frame: n + 1,
          frames,
          fps,
          elapsedSeconds: elapsed,
          etaSeconds: n > 10 ? (frames - n - 1) / fps : Number.NaN,
        });
      }
    }
    stdin.end();
    const code = await exited;
    if (signal?.aborted) throw new ExportError('Export cancelled');
    if (code !== 0) throw new ExportError(`ffmpeg failed (exit code ${code}):\n${tail(stderr)}`);
  } catch (error) {
    child.kill();
    await exited.catch(() => null);
    // Do not leave a broken video behind.
    if (project.export.mode === 'video') await rm(outputPath, { force: true }).catch(() => undefined);
    // Killing ffmpeg breaks the pipe it reads frames from ("write EOF"): still a cancellation.
    throw signal?.aborted ? new ExportError('Export cancelled') : error;
  } finally {
    signal?.removeEventListener('abort', abort);
    // Pending frames resolve or fail with the workers; nothing waits for them any more.
    for (const pending of requested.values()) pending.catch(() => undefined);
    await source.close();
  }
  return {
    outputPath,
    frames,
    seconds: (Date.now() - started) / 1000,
    encoder: encoder?.name ?? null,
    workers: source.threads,
    warnings: [...warnings],
  };
}
