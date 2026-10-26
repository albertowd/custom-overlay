import type {
  ImageSequencePlan,
  Project,
  ProjectMedia,
  SourceKind,
  TelemetrySeries,
} from '@custom-overlay/core';
import type { LoadedVideo } from '@custom-overlay/core/loaders';
import type { ValuesSnapshot } from '@custom-overlay/ui/api';

/**
 * Work done off the page, in the engine worker: what the desktop app's main process does. The
 * worker keeps the loaded media, so evaluating values only sends the project.
 */
export interface EngineOperations {
  loadVideo: {
    args: { path: string; file: File; subtitles: File | null };
    result: LoadedVideo;
  };
  loadSource: {
    args: { path: string; kind: SourceKind; file: File; subtitles: File | null };
    result: TelemetrySeries;
  };
  evaluateValues: {
    args: { project: Project; frameRate: number };
    result: ValuesSnapshot;
  };
  /** Frames of an image sequence export, and the media its frame workers need. */
  imageSequence: {
    args: { project: Project };
    result: { plan: ImageSequencePlan; media: ProjectMedia };
  };
}

export type EngineOperation = keyof EngineOperations;

export type EngineRequest = {
  [K in EngineOperation]: { id: number; operation: K; args: EngineOperations[K]['args'] };
}[EngineOperation];

export type EngineResponse =
  | { id: number; ok: true; result: EngineOperations[EngineOperation]['result'] }
  | { id: number; ok: false; message: string };
