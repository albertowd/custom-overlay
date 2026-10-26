// Loading media and files on any platform: the caller gives the bytes (a file on disk in
// '@custom-overlay/core/node', a browser File in the web app), these functions read them.

import type { RandomAccessReader } from '../io/reader.js';
import { parseMp4 } from '../media/mp4.js';
import { extractGpmf, type VideoInfo, videoInfoFromMp4 } from '../media/probe.js';
import type { SourceKind, TelemetrySeries } from '../model/telemetry.js';
import { isDjiSrt, parseDjiSrt } from '../sources/dji-srt.js';
import { parseRaceChronoCsv } from '../sources/racechrono.js';
import { parseGoProTelemetry } from './gopro.js';

export { goproDevicesToSeries, parseGoProTelemetry } from './gopro.js';

export interface LoadedVideo {
  info: VideoInfo;
  /**
   * Telemetry of the video: embedded (GoPro GPMF) or a DJI subtitle file next to it with the same
   * name (`DJI_0001.MP4` + `DJI_0001.SRT`); null when there is none.
   */
  telemetry: TelemetrySeries | null;
}

/** A text file: its name and its contents. */
export interface TextFile {
  name: string;
  text: string;
}

/** The DJI subtitles next to a video (same name, `.srt`), null when there are none. */
export type FindSubtitles = () => Promise<TextFile | null>;

async function djiTelemetry(findSubtitles: FindSubtitles): Promise<TelemetrySeries | null> {
  const file = await findSubtitles();
  return file && isDjiSrt(file.text) ? parseDjiSrt(file.text, file.name) : null;
}

/** Read a video: its format and its telemetry (embedded, or the DJI subtitles next to it). */
export async function loadVideoFrom(
  reader: RandomAccessReader,
  path: string,
  findSubtitles: FindSubtitles,
): Promise<LoadedVideo> {
  const mp4 = await parseMp4(reader);
  const info = videoInfoFromMp4(mp4, path, reader.size);
  const gpmf = info.hasGpmf ? await extractGpmf(reader, mp4) : null;
  const telemetry = gpmf
    ? await parseGoProTelemetry(gpmf, `${info.fileName} (embedded)`)
    : await djiTelemetry(findSubtitles);
  return { info, telemetry };
}

/** A data source file, however its bytes are reached. */
export interface SourceInput {
  /** File name: names the series and the file in errors. */
  name: string;
  readText(): Promise<string>;
  /** Random access to the file, for videos used only for their telemetry. */
  withReader<T>(read: (reader: RandomAccessReader) => Promise<T>): Promise<T>;
  findSubtitles: FindSubtitles;
}

export async function loadSourceFrom(input: SourceInput, kind: SourceKind | null): Promise<TelemetrySeries> {
  const { name } = input;
  switch (kind) {
    case 'racechrono':
      return parseRaceChronoCsv(await input.readText(), name);
    case 'dji':
      return parseDjiSrt(await input.readText(), name);
    case 'gopro': {
      // A video used only for its telemetry: GoPro GPMF, or the DJI subtitles next to it.
      const series = await input.withReader(async (reader) => {
        const gpmf = await extractGpmf(reader);
        return gpmf ? parseGoProTelemetry(gpmf, name) : null;
      });
      const telemetry = series ?? (await djiTelemetry(input.findSubtitles));
      if (!telemetry)
        throw new Error(`'${name}' has no telemetry (GoPro GPMF or a DJI .SRT file next to it)`);
      return telemetry;
    }
    default:
      throw new Error(`Unsupported data source: '${name}'`);
  }
}
