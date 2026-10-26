import type { FrameRendererInit } from '@custom-overlay/core';

/** Messages to an export worker: set it up once, then ask for frames. */
export type ExportWorkerRequest =
  | { type: 'init'; init: FrameRendererInit }
  | { type: 'frame'; frame: number };

/** Answers of an export worker: a frame is a PNG file (straight alpha). */
export type ExportWorkerResponse =
  | { type: 'ready' }
  | { type: 'frame'; frame: number; png: Uint8Array; warnings: string[] }
  | { type: 'error'; message: string };
