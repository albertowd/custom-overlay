import {
  type FrameRendererInit,
  outputBaseName,
  type Project,
  sequenceFrameName,
  ZipWriter,
} from '@custom-overlay/core';
import type { ExportProgress, ExportResult } from '@custom-overlay/core/node';
import { runInEngine } from './engine';
import type { ExportWorkerRequest, ExportWorkerResponse } from './export-protocol';
import { download } from './files';

/** Where the frames of an image sequence go. */
export interface SequenceTarget {
  /** Shown as the export's output. */
  name: string;
  write(fileName: string, png: Uint8Array): Promise<void>;
  /** Called once every frame is written. */
  finish(): Promise<void>;
}

/** PNG files in a folder the user picked (File System Access API). */
export function folderTarget(folder: FileSystemDirectoryHandle): SequenceTarget {
  return {
    name: folder.name,
    async write(fileName, png) {
      const file = await folder.getFileHandle(fileName, { create: true });
      const stream = await file.createWritable();
      await stream.write(png as Uint8Array<ArrayBuffer>);
      await stream.close();
    },
    finish: async () => undefined,
  };
}

/**
 * One zip file, downloaded at the end, for browsers that cannot write into a folder. Each piece
 * becomes its own Blob, which the browser may keep on disk rather than in memory.
 */
export function zipTarget(project: Project): SequenceTarget {
  const name = `${outputBaseName(project)} frames.zip`;
  const parts: Blob[] = [];
  const zip = new ZipWriter((chunk) => {
    parts.push(new Blob([chunk as Uint8Array<ArrayBuffer>]));
  });
  return {
    name,
    write: (fileName, png) => zip.add(fileName, png),
    async finish() {
      await zip.finish();
      download(new Blob(parts, { type: 'application/zip' }), name);
    },
  };
}

interface RenderedPng {
  png: Uint8Array;
  warnings: string[];
}

interface Pending {
  resolve(frame: RenderedPng): void;
  reject(error: Error): void;
}

/** Frame workers sharing the drawing: frame n goes to worker n mod count. */
class FramePool {
  private readonly waiting: Map<number, Pending>[];

  private constructor(private readonly workers: Worker[]) {
    this.waiting = workers.map(() => new Map());
  }

  get size(): number {
    return this.workers.length;
  }

  static async start(init: FrameRendererInit, count: number): Promise<FramePool> {
    const workers = Array.from(
      { length: count },
      () => new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' }),
    );
    const pool = new FramePool(workers);
    try {
      await Promise.all(workers.map((worker, w) => pool.listen(worker, w, init)));
    } catch (error) {
      pool.close();
      throw error;
    }
    return pool;
  }

  /** Wire a worker's answers; resolves once it is set up. */
  private listen(worker: Worker, w: number, init: FrameRendererInit): Promise<void> {
    return new Promise((ready, failed) => {
      const fail = (error: Error) => {
        failed(error);
        for (const pending of this.waiting[w]?.values() ?? []) pending.reject(error);
        this.waiting[w]?.clear();
      };
      worker.addEventListener('error', (event) => fail(new Error(event.message || 'Export worker failed')));
      worker.addEventListener('message', (event: MessageEvent<ExportWorkerResponse>) => {
        const message = event.data;
        if (message.type === 'ready') ready();
        else if (message.type === 'error') fail(new Error(message.message));
        else {
          this.waiting[w]?.get(message.frame)?.resolve({ png: message.png, warnings: message.warnings });
          this.waiting[w]?.delete(message.frame);
        }
      });
      worker.postMessage({ type: 'init', init } satisfies ExportWorkerRequest);
    });
  }

  frame(n: number): Promise<RenderedPng> {
    const w = n % this.workers.length;
    return new Promise((resolve, reject) => {
      this.waiting[w]?.set(n, { resolve, reject });
      this.workers[w]?.postMessage({ type: 'frame', frame: n } satisfies ExportWorkerRequest);
    });
  }

  close(): void {
    for (const worker of this.workers) worker.terminate();
  }
}

/** Drawing workers: half the cores (the page and the writes need the rest), 1 to 6. */
const defaultWorkers = () => Math.max(1, Math.min(6, Math.floor((navigator.hardwareConcurrency || 2) / 2)));

export interface SequenceExportOptions {
  project: Project;
  target: SequenceTarget;
  signal: AbortSignal;
  onProgress(progress: ExportProgress): void;
  workers?: number;
}

/**
 * Export a transparent PNG sequence in the browser: frames are drawn by the editor's widget code
 * on worker threads (OffscreenCanvas) and written in order, like the desktop export.
 */
export async function exportImageSequence(options: SequenceExportOptions): Promise<ExportResult> {
  const { project, target, signal } = options;
  const started = performance.now();
  const { plan, media } = await runInEngine('imageSequence', { project });
  const { width, height, frameRate, start, frames } = plan;
  if (frames === 0) throw new Error('The export range is empty');
  const pool = await FramePool.start(
    { project, media, template: project.template, palette: project.palette, width, height, frameRate, start },
    options.workers ?? defaultWorkers(),
  );
  const warnings = new Set<string>();
  // Frames requested ahead, so every worker stays busy while frames are written in order.
  const ahead = Math.max(2, pool.size * 3);
  const requested = new Map<number, Promise<RenderedPng>>();
  let scheduled = 0;
  let lastReport = 0;
  try {
    for (let n = 0; n < frames; n++) {
      if (signal.aborted) throw new Error('Export cancelled');
      while (scheduled < frames && scheduled < n + ahead) {
        requested.set(scheduled, pool.frame(scheduled));
        scheduled++;
      }
      const frame = await requested.get(n);
      requested.delete(n);
      if (!frame) break;
      for (const warning of frame.warnings) warnings.add(warning);
      await target.write(sequenceFrameName(n), frame.png);
      const now = performance.now();
      if (now - lastReport > 250 || n === frames - 1) {
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
    if (signal.aborted) throw new Error('Export cancelled');
    await target.finish();
  } finally {
    // Pending frames fail with the workers; nothing waits for them any more.
    for (const pending of requested.values()) pending.catch(() => undefined);
    pool.close();
  }
  return {
    outputPath: target.name,
    frames,
    seconds: (performance.now() - started) / 1000,
    encoder: null,
    workers: pool.size,
    warnings: [...warnings],
  };
}
