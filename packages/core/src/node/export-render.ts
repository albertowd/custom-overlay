import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createFrameDrawer, type FrameRendererInit, type RenderPlatform } from '../export/frames.js';

export type { FrameRendererInit } from '../export/frames.js';

export interface RenderedFrame {
  /** Premultiplied RGBA, width × height × 4 bytes. */
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
export async function createFrameRenderer(init: FrameRendererInit): Promise<FrameRenderer> {
  const draw = await createFrameDrawer(init, skia);
  const canvas = createCanvas(init.width, init.height);
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  return {
    render(frame) {
      const warnings = draw(ctx, frame);
      // Skia's own buffer, premultiplied: copied so it can be transferred and reused.
      return { pixels: new Uint8Array(canvas.data()), warnings };
    },
  };
}
