import type { RandomAccessReader } from '../io/reader.js';
import type { ColorSettings } from '../model/project.js';
import { decodeText, findKlv, klvString } from './gpmf-klv.js';
import { findVideoTrack, type Mp4Info, type Mp4Track, parseMp4, readTrackSamples } from './mp4.js';

export interface VideoInfo {
  path: string;
  fileName: string;
  sizeBytes: number;
  durationSeconds: number;
  width: number;
  height: number;
  frameRate: number;
  frameCount: number;
  /** Sample entry fourcc, e.g. 'avc1' (H.264) or 'hvc1' (H.265). */
  codec: string;
  /** MP4 creation time as written by the camera (GoPro: local time, no timezone). */
  creationTime: string | null;
  hasGpmf: boolean;
  /** Whether the file has a sound track. */
  hasAudio: boolean;
  /** Colour space / range / bit depth, Rec.709 limited 8-bit when the file does not say. */
  color: ColorSettings;
  camera: { model: string | null; firmware: string | null };
  /**
   * Camera clock readings, distinct, most reliable first. GoPro cameras store local time as if it
   * were UTC, so these are used (with timezone guesses) only when there is no GPS time.
   */
  clock: ClockReading[];
}

export interface ClockReading {
  source: 'mvhd' | 'mdhd' | 'cdat';
  /** Epoch milliseconds as stored by the camera (usually local time without timezone). */
  epochMs: number;
}

/** Raw GPMF payload plus the timing info expected by GPMF parsers (gpmf-extract compatible). */
export interface GpmfTrackData {
  rawData: Uint8Array;
  timing: {
    videoDuration: number;
    /** Seconds per video frame. */
    frameDuration: number;
    start: Date;
    /** Start (cts) and duration of every GPMF sample, in milliseconds. */
    samples: { cts: number; duration: number }[];
  };
}

const CODEC_NAMES: Record<string, string> = {
  avc1: 'H.264',
  avc3: 'H.264',
  hvc1: 'H.265 / HEVC',
  hev1: 'H.265 / HEVC',
  av01: 'AV1',
  vp09: 'VP9',
};

export function describeCodec(fourcc: string): string {
  return CODEC_NAMES[fourcc] ?? fourcc;
}

export function findGpmfTrack(info: Mp4Info): Mp4Track | undefined {
  return info.tracks.find((t) => t.format === 'gpmd');
}

/** CDAT in the udta GPMF box: creation date as local epoch seconds. */
function readCdat(info: Mp4Info): number | null {
  const gpmf = info.userData.GPMF;
  const cdat = gpmf ? findKlv(gpmf, 'CDAT') : null;
  if (!cdat) return null;
  const view = new DataView(cdat.payload.buffer, cdat.payload.byteOffset, cdat.payload.byteLength);
  if (cdat.structSize === 8 && cdat.payload.byteLength >= 8) return Number(view.getBigUint64(0)) * 1000;
  if (cdat.structSize === 4 && cdat.payload.byteLength >= 4) return view.getUint32(0) * 1000;
  return null;
}

export function readClock(info: Mp4Info): ClockReading[] {
  const candidates: [ClockReading['source'], number | null | undefined][] = [
    ['mvhd', info.creationTime?.getTime()],
    ['mdhd', findVideoTrack(info)?.creationTime?.getTime()],
    ['cdat', readCdat(info)],
  ];
  const readings: ClockReading[] = [];
  for (const [source, epochMs] of candidates) {
    // Ignore unset clocks (before 2000) and duplicates.
    if (!epochMs || epochMs < Date.UTC(2000, 0, 1)) continue;
    if (readings.some((r) => Math.abs(r.epochMs - epochMs) < 1)) continue;
    readings.push({ source, epochMs });
  }
  return readings;
}

function readCamera(info: Mp4Info): VideoInfo['camera'] {
  const gpmf = info.userData.GPMF;
  return {
    model: gpmf ? klvString(findKlv(gpmf, 'MINF')) : null,
    firmware: decodeText(info.userData.FIRM),
  };
}

// H.273 code points
const PRIMARIES_BT2020 = 9;
const TRANSFER_PQ = 16;
const TRANSFER_HLG = 18;

export function colorSettingsOf(track: Mp4Track): ColorSettings {
  const { color } = track;
  let space: ColorSettings['space'] = 'rec709';
  if (color?.transfer === TRANSFER_PQ) space = 'rec2020-pq';
  else if (color?.transfer === TRANSFER_HLG) space = 'rec2020-hlg';
  else if (color?.primaries === PRIMARIES_BT2020) space = 'rec2020';
  return {
    space,
    range: color?.fullRange ? 'full' : 'limited',
    bitDepth: (track.bitDepth ?? 8) > 8 ? 10 : 8,
  };
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

export function videoInfoFromMp4(info: Mp4Info, path: string, sizeBytes: number): VideoInfo {
  const video = findVideoTrack(info);
  if (!video) throw new Error('The file has no video track');
  const durationSeconds = video.durationSeconds || info.durationSeconds;
  const frameRate = durationSeconds > 0 ? video.sampleCount / durationSeconds : 0;
  return {
    path,
    fileName: baseName(path),
    sizeBytes,
    durationSeconds,
    width: video.width ?? 0,
    height: video.height ?? 0,
    frameRate: Math.round(frameRate * 1000) / 1000,
    frameCount: video.sampleCount,
    codec: video.format,
    creationTime: info.creationTime?.toISOString() ?? null,
    hasGpmf: findGpmfTrack(info) !== undefined,
    hasAudio: info.tracks.some((t) => t.handlerType === 'soun'),
    color: colorSettingsOf(video),
    camera: readCamera(info),
    clock: readClock(info),
  };
}

export async function probeVideo(reader: RandomAccessReader, path: string): Promise<VideoInfo> {
  return videoInfoFromMp4(await parseMp4(reader), path, reader.size);
}

/** Extract the GoPro GPMF metadata track, or null when the file has none. */
export async function extractGpmf(reader: RandomAccessReader, info?: Mp4Info): Promise<GpmfTrackData | null> {
  const mp4 = info ?? (await parseMp4(reader));
  const track = findGpmfTrack(mp4);
  if (!track || track.sampleCount === 0) return null;
  const video = findVideoTrack(mp4);
  const videoDuration = video?.durationSeconds ?? mp4.durationSeconds;
  const rawData = await readTrackSamples(reader, track);
  const toMs = 1000 / track.timescale;
  return {
    rawData,
    timing: {
      videoDuration,
      frameDuration: video && video.sampleCount > 0 ? videoDuration / video.sampleCount : 1 / 30,
      start: mp4.creationTime ?? new Date(0),
      samples: track.samples.times.map((t, i) => ({
        cts: t * toMs,
        duration: (track.samples.durations[i] ?? 0) * toMs,
      })),
    },
  };
}
