import type { Project } from '@custom-overlay/core';
import type { ExportProgress, ExportResult } from '@custom-overlay/core/node';
import { runInEngine } from './engine';
import { download, fileAt } from './files';
import { defaultWorkers } from './frame-pool';
import type {
  VideoJobResult,
  VideoTarget,
  VideoWorkerRequest,
  VideoWorkerResponse,
} from './video-export-protocol';

/** Whether this browser can export the final video (WebCodecs, canvases in workers). */
export function canExportVideo(): boolean {
  return (
    typeof VideoEncoder === 'function' &&
    typeof VideoDecoder === 'function' &&
    typeof OffscreenCanvas === 'function' &&
    typeof navigator.storage?.getDirectory === 'function'
  );
}

/** Folder of the browser's private storage where videos are written before being downloaded. */
const EXPORTS = 'exports';

/** Remove the videos of earlier exports kept in the browser's private storage (already downloaded). */
async function clearPrivateExports(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(EXPORTS, { recursive: true });
  } catch {
    // Nothing kept yet.
  }
}

export interface VideoExportOptions {
  project: Project;
  /** A file picked to write to; null writes to the browser's storage and downloads the video. */
  file: FileSystemFileHandle | null;
  /** File name of the download. */
  name: string;
  signal: AbortSignal;
  onProgress(progress: ExportProgress): void;
  workers?: number;
}

/** Export the final video in the browser (see `video-export.worker.ts`). */
export async function exportVideo(options: VideoExportOptions): Promise<ExportResult> {
  const { project, signal } = options;
  const started = performance.now();
  const { plan, media } = await runInEngine('videoExport', { project });
  if (plan.frames === 0) throw new Error('The export range is empty');
  const files: Record<string, File> = {};
  for (const segment of plan.segments) {
    if (segment.kind === 'video') files[segment.video.id] = fileAt(segment.video.path);
  }
  if (!options.file) await clearPrivateExports();
  const target: VideoTarget = options.file
    ? { kind: 'file', handle: options.file }
    : { kind: 'private', name: options.name };
  const { width, height, frameRate, start } = plan;

  const worker = new Worker(new URL('./video-export.worker.ts', import.meta.url), { type: 'module' });
  const cancel = () => worker.postMessage({ type: 'cancel' } satisfies VideoWorkerRequest);
  signal.addEventListener('abort', cancel, { once: true });
  let result: VideoJobResult;
  try {
    result = await new Promise<VideoJobResult>((resolve, reject) => {
      worker.addEventListener('error', (event) => reject(new Error(event.message || 'Video export failed')));
      worker.addEventListener('message', (event: MessageEvent<VideoWorkerResponse>) => {
        const message = event.data;
        if (message.type === 'progress') options.onProgress(message.progress);
        else if (message.type === 'done') resolve(message.result);
        else reject(new Error(message.cancelled ? 'Export cancelled' : message.message));
      });
      worker.postMessage({
        type: 'start',
        job: {
          plan,
          overlay: {
            project,
            media,
            template: project.template,
            palette: project.palette,
            width,
            height,
            frameRate,
            start,
          },
          files,
          fit: project.output.fit,
          encoder: project.export.encoder,
          target,
          workers: options.workers ?? defaultWorkers(),
        },
      } satisfies VideoWorkerRequest);
    });
  } finally {
    signal.removeEventListener('abort', cancel);
    worker.terminate();
  }
  if (target.kind === 'private') {
    // A file of the private storage stays on disk: the download streams it from there.
    const root = await navigator.storage.getDirectory();
    const folder = await root.getDirectoryHandle(EXPORTS);
    download(await (await folder.getFileHandle(target.name)).getFile(), target.name);
  }
  return {
    outputPath: options.file?.name ?? options.name,
    frames: result.frames,
    seconds: (performance.now() - started) / 1000,
    encoder: result.encoder,
    workers: options.workers ?? defaultWorkers(),
    // The browser draws and encodes the frames itself, without ffmpeg's CUDA filters.
    pipeline: 'cpu',
    warnings: result.warnings,
  };
}
