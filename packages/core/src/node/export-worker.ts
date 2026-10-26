import { parentPort } from 'node:worker_threads';
import { createFrameRenderer, type FrameRenderer, type FrameRendererInit } from './export-render.js';

/** Messages to an export worker. */
export type ExportWorkerRequest =
  | { type: 'init'; init: FrameRendererInit }
  | { type: 'frame'; frame: number };

/** Messages from an export worker. */
export type ExportWorkerResponse =
  | { type: 'ready' }
  | { type: 'frame'; frame: number; pixels: Uint8Array; warnings: string[] }
  | { type: 'error'; message: string };

/**
 * Body of an export worker thread: builds a frame renderer on `init`, then draws the requested
 * frames in order and sends their pixels back (transferred, not copied).
 */
export function runExportWorker(): void {
  const port = parentPort;
  if (!port) throw new Error('runExportWorker must run in a worker thread');
  let renderer: Promise<FrameRenderer> | null = null;
  port.on('message', async (request: ExportWorkerRequest) => {
    try {
      if (request.type === 'init') {
        renderer = createFrameRenderer(request.init);
        await renderer;
        port.postMessage({ type: 'ready' } satisfies ExportWorkerResponse);
        return;
      }
      if (!renderer) throw new Error('Export worker used before init');
      const { pixels, warnings } = (await renderer).render(request.frame);
      const response: ExportWorkerResponse = { type: 'frame', frame: request.frame, pixels, warnings };
      port.postMessage(response, [pixels.buffer as ArrayBuffer]);
    } catch (error) {
      port.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      } satisfies ExportWorkerResponse);
    }
  });
}
