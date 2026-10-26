// First: before gopro-telemetry loads.
import './set-immediate';

import { imageSequencePlan, ProjectValues, type RandomAccessReader } from '@custom-overlay/core';
import { type FindSubtitles, loadSourceFrom, loadVideoFrom } from '@custom-overlay/core/loaders';
import { evaluateProjectValues, projectMedia, rememberSource, rememberVideo } from '@custom-overlay/ui/host';
import type { EngineOperation, EngineOperations, EngineRequest, EngineResponse } from './engine-protocol';

/**
 * Random access to a browser File: only the bytes asked for are read, never the whole file, so
 * GoPro recordings over 10 GB load like small ones.
 */
class BlobReader implements RandomAccessReader {
  constructor(private readonly blob: Blob) {}

  get size(): number {
    return this.blob.size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    return new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer());
  }
}

const subtitlesOf =
  (file: File | null): FindSubtitles =>
  async () =>
    file ? { name: file.name, text: await file.text() } : null;

type Handlers = {
  [K in EngineOperation]: (
    args: EngineOperations[K]['args'],
  ) => Promise<EngineOperations[K]['result']> | EngineOperations[K]['result'];
};

const handlers: Handlers = {
  async loadVideo({ path, file, subtitles }) {
    const video = await loadVideoFrom(new BlobReader(file), path, subtitlesOf(subtitles));
    rememberVideo(path, video.info, video.telemetry);
    return video;
  },
  async loadSource({ path, kind, file, subtitles }) {
    const series = await loadSourceFrom(
      {
        name: file.name,
        readText: () => file.text(),
        withReader: (read) => read(new BlobReader(file)),
        findSubtitles: subtitlesOf(subtitles),
      },
      kind,
    );
    rememberSource(path, kind, series);
    return series;
  },
  // Value scripts are compiled here: the page's Content-Security-Policy forbids it.
  evaluateValues: ({ project, frameRate }) => evaluateProjectValues(project, frameRate),
  imageSequence({ project }) {
    const media = projectMedia(project);
    // Open range bounds follow the data range of the Track step, like the export step shows.
    const dataRange = new ProjectValues(project, media).resolve(project.dataRange).range;
    return { plan: imageSequencePlan(project, media, dataRange), media };
  },
};

async function handle(request: EngineRequest): Promise<EngineResponse> {
  try {
    const run = handlers[request.operation] as (args: EngineRequest['args']) => unknown;
    const result = (await run(request.args)) as EngineOperations[EngineOperation]['result'];
    return { id: request.id, ok: true, result };
  } catch (error) {
    return { id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

addEventListener('message', (event: MessageEvent<EngineRequest>) => {
  void handle(event.data).then((response) => postMessage(response));
});
