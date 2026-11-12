import type { FrameRendererInit } from '@custom-overlay/core';

/**
 * How a drawing worker hands frames back: PNG files (straight alpha) for image sequences, or
 * bitmaps to draw over the video of a video export.
 */
export type FrameFormat = 'png' | 'bitmap';

/** Messages to an export worker: set it up once, then ask for frames. */
export type ExportWorkerRequest =
  | { type: 'init'; init: FrameRendererInit; format?: FrameFormat }
  | { type: 'frame'; frame: number };

/** Answers of an export worker. */
export type ExportWorkerResponse =
  | { type: 'ready' }
  | { type: 'frame'; frame: number; png: Uint8Array; warnings: string[] }
  | { type: 'bitmap'; frame: number; bitmap: ImageBitmap; warnings: string[] }
  | { type: 'error'; message: string };
