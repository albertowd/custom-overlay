import { outputBaseName, type Project, sequenceFrameName, ZipWriter } from '@custom-overlay/core';
import type { ExportProgress, ExportResult } from '@custom-overlay/core/node';
import { runInEngine } from './engine';
import { download } from './files';
import { type DrawnFrame, defaultWorkers, FramePool } from './frame-pool';

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
    'png',
  );
  const warnings = new Set<string>();
  // Frames requested ahead, so every worker stays busy while frames are written in order.
  const ahead = Math.max(2, pool.size * 3);
  const requested = new Map<number, Promise<DrawnFrame<'png'>>>();
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
      await target.write(sequenceFrameName(n), frame.data);
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
    pipeline: 'cpu',
    warnings: [...warnings],
  };
}
