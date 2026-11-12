import type { EncoderSettings, FrameRendererInit, VideoExportPlan, VideoFit } from '@custom-overlay/core';
import type { ExportProgress } from '@custom-overlay/core/node';

/** Where the video is written: a file the user picked, or the browser's private storage. */
export type VideoTarget =
  | { kind: 'file'; handle: FileSystemFileHandle }
  /** Origin private file system, `exports/<name>`: downloaded once finished. */
  | { kind: 'private'; name: string };

export interface VideoJob {
  plan: VideoExportPlan;
  /** For the drawing workers. */
  overlay: FrameRendererInit;
  /** The files of the videos, by video id. */
  files: Record<string, File>;
  fit: VideoFit;
  encoder: EncoderSettings;
  target: VideoTarget;
  /** Drawing workers. */
  workers: number;
}

export interface VideoJobResult {
  frames: number;
  /** Codecs used, e.g. `avc + aac`. */
  encoder: string;
  warnings: string[];
}

export type VideoWorkerRequest = { type: 'start'; job: VideoJob } | { type: 'cancel' };

export type VideoWorkerResponse =
  | { type: 'progress'; progress: ExportProgress }
  | { type: 'done'; result: VideoJobResult }
  | { type: 'error'; message: string; cancelled: boolean };
