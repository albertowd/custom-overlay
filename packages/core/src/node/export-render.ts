import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createFrameDrawer, type FrameRendererInit, type RenderPlatform } from '../export/frames.js';
import { rgbaToYuva420p, type YuvConversion } from '../export/yuv.js';

export type { FrameRendererInit } from '../export/frames.js';

/** Pixels the renderer hands out: Skia's premultiplied RGBA, or straight alpha `yuva420p`. */
export type FramePixelFormat = { format: 'rgba' } | ({ format: 'yuva420p' } & YuvConversion);

export interface RenderedFrame {
  /** Premultiplied RGBA (width × height × 4 bytes), or `yuva420p` when asked for. */
  pixels: Uint8Array;
  /** Widget errors of this frame, as `name: message`. */
  warnings: string[];
}

export interface FrameRenderer {
  render(frame: number): RenderedFrame;
}

/** Skia canvases (@napi-rs/canvas). */
const skia: RenderPlatform = {
  createCanvas(width, height) {
    const canvas = createCanvas(width, height);
    return {
      canvas: canvas as unknown as CanvasImageSource,
      ctx: canvas.getContext('2d') as unknown as CanvasRenderingContext2D,
    };
  },
  loadImage: async (src) => (await loadImage(src)) as unknown as CanvasImageSource,
};

/** Draws export frames on a Skia canvas and hands out its raw pixels (for ffmpeg). */
export async function createFrameRenderer(
  init: FrameRendererInit,
  pixelFormat: FramePixelFormat = { format: 'rgba' },
): Promise<FrameRenderer> {
  const draw = await createFrameDrawer(init, skia);
  const canvas = createCanvas(init.width, init.height);
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  return {
    render(frame) {
      const warnings = draw(ctx, frame);
      // A copy of Skia's pixels (premultiplied), freed by the canvas once the event loop turns.
      const data = canvas.data();
      const pixels =
        pixelFormat.format === 'yuva420p'
          ? rgbaToYuva420p(data, init.width, init.height, pixelFormat)
          : // A new buffer each time, so it can be transferred to the thread writing to ffmpeg.
            new Uint8Array(data);
      return { pixels, warnings };
    },
  };
}
