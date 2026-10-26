// Builders of realistic renderer data (videos, telemetry, value snapshots, known tracks) and a
// reset of the app stores between tests.
import {
  addSource,
  addVideo,
  type CatalogTrack,
  type Channel,
  createProject,
  embeddedSourceId,
  type Project,
  type TelemetrySeries,
  type VideoInfo,
} from '@custom-overlay/core';
import { useLanguage } from '../../../src/app/i18n';
import { useStore } from '../../../src/app/store';
import type { LoadedVideoPayload, ValuesSnapshot } from '../../../src/shared/api';
import { DEFAULT_LANGUAGE } from '../../../src/shared/i18n';

/** Put the app and language stores back to their first state. */
export function resetStores(): void {
  useStore.setState(useStore.getInitialState(), true);
  useLanguage.setState({ language: DEFAULT_LANGUAGE });
}

/** A one-minute 1080p60 video without telemetry. */
export function videoInfo(overrides: Partial<VideoInfo> = {}): VideoInfo {
  const path = overrides.path ?? '/videos/run.mp4';
  return {
    path,
    fileName: path.split(/[\\/]/).pop() ?? path,
    sizeBytes: 150 * 1024 * 1024,
    durationSeconds: 60,
    width: 1920,
    height: 1080,
    frameRate: 60,
    frameCount: 3600,
    codec: 'h264',
    creationTime: null,
    hasGpmf: false,
    hasAudio: true,
    color: { space: 'rec709', range: 'limited', bitDepth: 8 },
    camera: { model: null, firmware: null },
    clock: [],
    ...overrides,
  };
}

/** A channel sampled at `rate` Hz for `duration` seconds. */
export function channel(
  key: string,
  unit: string,
  duration: number,
  rate: number,
  value: (t: number) => number,
): Channel {
  const n = Math.floor(duration * rate);
  const time = Float64Array.from({ length: n }, (_, i) => i / rate);
  return { key, label: key, unit, time, values: time.map(value) };
}

/**
 * Speed (m/s) of a session: smooth and never repeating, so two series of the same session sync.
 * `offset` is where this recording starts in the session (seconds); clock times are set from
 * `sessionEpochMs` when given (a confident sync), else unknown.
 */
export function speedSeries({
  duration = 60,
  offset = 0,
  kind = 'racechrono',
  sessionEpochMs = null,
}: {
  duration?: number;
  offset?: number;
  kind?: TelemetrySeries['kind'];
  sessionEpochMs?: number | null;
} = {}): TelemetrySeries {
  return {
    kind,
    name: 'session',
    startEpochMs: sessionEpochMs === null ? null : sessionEpochMs + offset * 1000,
    channels: [
      channel(
        'speed',
        'm/s',
        duration,
        10,
        (t) => 30 + 6 * Math.sin((t + offset) / 7) + 4 * Math.sin((t + offset) * 1.3),
      ),
    ],
    metadata: {},
  };
}

/** Start / finish line of `TEST_TRACK`: west-east at latitude 10, longitude 20 to 20.002. */
export const TEST_TRACK: CatalogTrack = {
  id: 'xx/test-ring',
  country: 'XX',
  location: 'Testville',
  track: {
    name: 'Test Ring',
    startFinish: {
      a: { latitude: 10, longitude: 20 },
      b: { latitude: 10, longitude: 20.002 },
    },
    sectors: [],
    timing: 'auto',
    minLapSeconds: 10,
  },
};

/** Positions driving north across the `TEST_TRACK` start / finish line once. */
export function gpsSeries(kind: TelemetrySeries['kind'] = 'racechrono', duration = 60): TelemetrySeries {
  const rate = 10;
  return {
    kind,
    name: 'gps',
    startEpochMs: null,
    channels: [
      channel('latitude', 'deg', duration, rate, (t) => 9.999 + (0.002 * t) / duration),
      channel('longitude', 'deg', duration, rate, () => 20.001),
      channel('speed', 'm/s', duration, rate, () => 20),
    ],
    metadata: {},
  };
}

/** What `api().loadVideo` answers for a video. */
export function loadedVideo(
  path: string,
  telemetry: TelemetrySeries | null = null,
  info: Partial<VideoInfo> = {},
): LoadedVideoPayload {
  return {
    info: videoInfo({ path, hasGpmf: telemetry !== null, ...info }),
    telemetry,
    mediaUrl: `media://local/${encodeURIComponent(path)}`,
  };
}

/** A values snapshot of `count` frames at `frameRate` with the given data by value id. */
export function valuesSnapshot(
  data: Record<string, number[]> = {},
  { start = 0, frameRate = 30, count }: { start?: number; frameRate?: number; count?: number } = {},
): ValuesSnapshot {
  const frames = count ?? Math.max(0, ...Object.values(data).map((d) => d.length));
  const arrays = Object.fromEntries(Object.entries(data).map(([id, d]) => [id, Float64Array.from(d)]));
  return {
    grid: { start, frameRate, count: frames },
    values: [],
    data: arrays,
    errors: {},
    full: arrays,
    ranges: {},
    dataRange: null,
    dataRangeProblems: [],
  };
}

/** A project named `name` (the store's default project otherwise). */
export function project(name = 'Test project', overrides: Partial<Project> = {}): Project {
  return { ...createProject({ name }), ...overrides };
}

/** Clock time of the test session's start. */
export const SESSION_EPOCH_MS = Date.UTC(2026, 5, 14, 10, 0, 0);

export interface Session {
  project: Project;
  videoId: string;
  /** The logger source (not the embedded telemetry). */
  sourceId: string;
  videos: Record<string, VideoInfo>;
  series: Record<string, TelemetrySeries>;
  mediaUrls: Record<string, string>;
}

/**
 * A GoPro video (with telemetry) starting 20 s into a 2-minute RaceChrono session, both with clock
 * times: the automatic sync finds the logger at -20 s with high confidence. With `gps`, the logger
 * also has positions crossing the `TEST_TRACK` start / finish line.
 */
export function sessionProject({
  gps = false,
  name = 'Session',
}: {
  gps?: boolean;
  name?: string;
} = {}): Session {
  const videoPath = '/videos/GX010001.MP4';
  const telemetry = speedSeries({ kind: 'gopro', offset: 20, sessionEpochMs: SESSION_EPOCH_MS });
  const loaded = loadedVideo(videoPath, telemetry);
  const withVideo = addVideo(createProject({ name }), {
    path: videoPath,
    info: loaded.info,
    hasTelemetry: true,
    telemetryKind: 'gopro',
  });
  const withSource = addSource(withVideo.project, { path: '/logs/session.csv', kind: 'racechrono' });
  const logger = speedSeries({ duration: 120, sessionEpochMs: SESSION_EPOCH_MS });
  if (gps) logger.channels.push(...gpsSeries('racechrono', 120).channels.filter((c) => c.key !== 'speed'));
  const videoId = withVideo.video.id;
  const sourceId = withSource.source.id;
  return {
    project: withSource.project,
    videoId,
    sourceId,
    videos: { [videoId]: loaded.info },
    series: { [embeddedSourceId(videoId)]: telemetry, [sourceId]: logger },
    mediaUrls: { [videoId]: loaded.mediaUrl },
  };
}

/** Put a `sessionProject` in the app store with its media loaded (not synced yet). */
export function loadSession(options: Parameters<typeof sessionProject>[0] = {}): Session {
  const session = sessionProject(options);
  useStore.setState({
    project: session.project,
    videos: session.videos,
    series: session.series,
    mediaUrls: session.mediaUrls,
  });
  return session;
}

export { api } from '../fake-api';
