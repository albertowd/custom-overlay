import { parentPort } from 'node:worker_threads';
import {
  createFrameRenderer,
  type FramePixelFormat,
  type FrameRenderer,
  type FrameRendererInit,
} from './export-render.js';

/** Messages to an export worker. */
export type ExportWorkerRequest =
  | { type: 'init'; init: FrameRendererInit; pixelFormat?: FramePixelFormat }
  | { type: 'frame'; frame: number };

/** Messages from an export worker. */
export type ExportWorkerResponse =
  | { type: 'ready' }
  | { type: 'frame'; frame: number; pixels: Uint8Array; warnings: string[] }
  | { type: 'error'; message: string };

/** Lets the event loop run once (`setImmediate` callbacks included). */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Body of an export worker thread: builds a frame renderer on `init`, then draws the requested
 * frames in order and sends their pixels back (transferred, not copied).
 *
 * Frames are drawn one per turn of the event loop. The canvas frees each frame's pixel buffer
 * (native memory) from a callback that only runs between turns: answering queued requests back
 * to back, as a thread that is always busy does, never got there and kept every 4K frame (33 MB),
 * until the process crashed.
 */
export function runExportWorker(): void {
  const port = parentPort;
  if (!port) throw new Error('runExportWorker must run in a worker thread');
  let renderer: Promise<FrameRenderer> | null = null;
  const queue: number[] = [];
  let drawing = false;
  const fail = (error: unknown) =>
    port.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    } satisfies ExportWorkerResponse);

  const drawQueued = async () => {
    if (drawing) return;
    drawing = true;
    try {
      for (let frame = queue.shift(); frame !== undefined; frame = queue.shift()) {
        if (!renderer) throw new Error('Export worker used before init');
        const { pixels, warnings } = (await renderer).render(frame);
        const response: ExportWorkerResponse = { type: 'frame', frame, pixels, warnings };
        port.postMessage(response, [pixels.buffer as ArrayBuffer]);
        await yieldToEventLoop();
      }
    } catch (error) {
      queue.length = 0;
      fail(error);
    } finally {
      drawing = false;
    }
  };

  port.on('message', async (request: ExportWorkerRequest) => {
    if (request.type === 'frame') {
      queue.push(request.frame);
      void drawQueued();
      return;
    }
    try {
      renderer = createFrameRenderer(request.init, request.pixelFormat);
      await renderer;
      port.postMessage({ type: 'ready' } satisfies ExportWorkerResponse);
    } catch (error) {
      fail(error);
    }
  });
}
