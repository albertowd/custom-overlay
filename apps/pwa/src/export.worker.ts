import { createFrameDrawer, type DrawFrame, type RenderPlatform } from '@custom-overlay/core';
import type { ExportWorkerRequest, ExportWorkerResponse } from './export-protocol';

function context(canvas: OffscreenCanvas): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas in this browser');
  return ctx as unknown as CanvasRenderingContext2D;
}

/** OffscreenCanvas: the same 2D canvas as the editor's preview, in a worker. */
const offscreen: RenderPlatform = {
  createCanvas(width, height) {
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, ctx: context(canvas) };
  },
  async loadImage(src) {
    return createImageBitmap(await (await fetch(src)).blob());
  },
};

/** The frame canvas and its context, set up by 'init'. */
let target: { canvas: OffscreenCanvas; ctx: CanvasRenderingContext2D } | null = null;
let draw: DrawFrame | null = null;
/** Frames are drawn one at a time on the worker's canvas. */
let queue: Promise<void> = Promise.resolve();

const reply = (response: ExportWorkerResponse, transfer: Transferable[] = []) =>
  postMessage(response, { transfer });

async function handle(request: ExportWorkerRequest): Promise<void> {
  if (request.type === 'init') {
    // A browser without 2D canvases fails here, before the export draws anything.
    const canvas = new OffscreenCanvas(request.init.width, request.init.height);
    target = { canvas, ctx: context(canvas) };
    draw = await createFrameDrawer(request.init, offscreen);
    reply({ type: 'ready' });
    return;
  }
  if (!target || !draw) throw new Error('The export worker is not set up');
  const warnings = draw(target.ctx, request.frame);
  // PNG keeps straight alpha: the browser converts the canvas' premultiplied pixels.
  const blob = await target.canvas.convertToBlob({ type: 'image/png' });
  const png = new Uint8Array(await blob.arrayBuffer());
  reply({ type: 'frame', frame: request.frame, png, warnings }, [png.buffer]);
}

addEventListener('message', (event: MessageEvent<ExportWorkerRequest>) => {
  queue = queue
    .then(() => handle(event.data))
    .catch((error: unknown) =>
      reply({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
    );
});
