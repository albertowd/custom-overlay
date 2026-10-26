import {
  addSource,
  addVideo,
  type Channel,
  createProject,
  DEFAULT_TRACK,
  embeddedSourceId,
  type Project,
  type SourceKind,
  suggestStartFinish,
  type TelemetrySeries,
  type Track,
  type VideoInfo,
} from '@custom-overlay/core';
import { useLanguage } from '../../../src/app/i18n';
import { type Store, useStore } from '../../../src/app/store';
import type { ValuesSnapshot } from '../../../src/shared/api';

const initialStore = useStore.getState();

export { api } from '../fake-api';

/** Back to the state of a freshly started app (English, empty project). */
export function resetStore(patch: Partial<Store> = {}): void {
  useStore.setState({ ...initialStore, project: createProject(), ...patch }, true);
  useLanguage.setState({ language: 'en' });
}

export function videoInfo(overrides: Partial<VideoInfo> = {}): VideoInfo {
  return {
    path: '/videos/GX010001.MP4',
    fileName: 'GX010001.MP4',
    sizeBytes: 1_500_000_000,
    durationSeconds: 120,
    width: 3840,
    height: 2160,
    frameRate: 59.94,
    frameCount: 7193,
    codec: 'hvc1',
    creationTime: null,
    hasGpmf: true,
    hasAudio: true,
    color: { space: 'rec709', range: 'full', bitDepth: 10 },
    camera: { model: 'HERO11 Black', firmware: 'H22.01' },
    clock: [],
    ...overrides,
  };
}

function channel(key: string, unit: string, time: Float64Array, values: Float64Array): Channel {
  return { key, label: key, unit, time, values };
}

/** Speed profile that never repeats, so the speed correlation finds one match. */
export function speedAt(t: number): number {
  return 30 + 6 * Math.sin(t / 7) + 8 * Math.sin(t / 3.1) * Math.cos(t / 11);
}

/** A series with a speed channel sampled from `start` of the session profile (and laps when asked). */
export function speedSeries(
  options: {
    start?: number;
    duration?: number;
    rate?: number;
    kind?: SourceKind;
    startEpochMs?: number | null;
    laps?: boolean;
  } = {},
): TelemetrySeries {
  const {
    start = 0,
    duration = 60,
    rate = 10,
    kind = 'racechrono',
    startEpochMs = null,
    laps = false,
  } = options;
  const n = Math.floor(duration * rate);
  const time = new Float64Array(n).map((_, i) => i / rate);
  const speed = time.map((t) => speedAt(start + t));
  const channels = [channel('speed', 'm/s', time, speed)];
  if (laps)
    channels.push(
      channel(
        'lap',
        '',
        time,
        time.map((t) => Math.floor(t / 20) + 1),
      ),
    );
  return { kind, name: 'test', startEpochMs, channels, metadata: {} };
}

/** A circuit driven in a circle: one lap every `period` seconds. */
export const CIRCLE = { latitude: 45, longitude: 9, radius: 0.001, period: 40 };

export interface CircleSession {
  time: Float64Array;
  latitude: Float64Array;
  longitude: Float64Array;
  lap: Float64Array;
  lapTime: Float64Array;
}

export function circleSession(duration = 130, rate = 10): CircleSession {
  const n = duration * rate;
  const time = new Float64Array(n).map((_, i) => i / rate);
  const angle = (t: number) => (2 * Math.PI * t) / CIRCLE.period;
  return {
    time,
    latitude: time.map((t) => CIRCLE.latitude + CIRCLE.radius * Math.sin(angle(t))),
    longitude: time.map((t) => CIRCLE.longitude + CIRCLE.radius * Math.cos(angle(t))),
    lap: time.map((t) => Math.floor(t / CIRCLE.period) + 1),
    lapTime: time.map((t) => t % CIRCLE.period),
  };
}

/** A GPS series of the circle session (what a RaceChrono log would give). */
export function circleSeries(session = circleSession()): TelemetrySeries {
  return {
    kind: 'racechrono',
    name: 'circle',
    startEpochMs: null,
    channels: [
      channel('latitude', 'deg', session.time, session.latitude),
      channel('longitude', 'deg', session.time, session.longitude),
    ],
    metadata: {},
  };
}

/** The circle's start/finish line, where the lap number changes. */
export function circleTrack(patch: Partial<Track> = {}): Track {
  const s = circleSession();
  const startFinish = suggestStartFinish(s.latitude, s.longitude, s.lap);
  if (!startFinish) throw new Error('no start/finish for the circle');
  return { ...DEFAULT_TRACK, name: 'Circle Ring', startFinish, ...patch };
}

/** Values snapshot of the circle session (positions and logger laps), on a 10 fps grid. */
export function circleSnapshot(options: { gps?: boolean; loggerLaps?: boolean; constantLap?: boolean } = {}) {
  const { gps = true, loggerLaps = true, constantLap = false } = options;
  const s = circleSession();
  const full: Record<string, Float64Array> = {};
  if (gps) {
    full.latitude = s.latitude;
    full.longitude = s.longitude;
  }
  if (loggerLaps) {
    full['imported.lap.number'] = constantLap ? s.lap.map(() => 1) : s.lap;
    full['imported.lap.time'] = s.lapTime;
  }
  const snapshot: ValuesSnapshot = {
    grid: { start: 0, frameRate: 10, count: s.time.length },
    values: [],
    data: full,
    errors: {},
    full,
    ranges: {},
    dataRange: null,
    dataRangeProblems: [],
  };
  return snapshot;
}

/** A project with one video (the reference) and its embedded telemetry, as the store holds it. */
export function withVideo(
  project: Project = createProject({ name: 'Session' }),
  options: { path?: string; info?: Partial<VideoInfo>; telemetry?: TelemetrySeries | null } = {},
) {
  const path = options.path ?? '/videos/GX010001.MP4';
  const info = videoInfo({ path, fileName: path.split('/').pop(), ...options.info });
  const telemetry = options.telemetry === undefined ? speedSeries({ kind: 'gopro' }) : options.telemetry;
  const added = addVideo(project, {
    path,
    info,
    hasTelemetry: telemetry !== null,
    telemetryKind: telemetry?.kind,
  });
  return { ...added, info, telemetry, embeddedId: embeddedSourceId(added.video.id) };
}

export function withSource(project: Project, path = '/logs/session.csv', kind: SourceKind = 'racechrono') {
  return addSource(project, { path, kind });
}

/** A File as a drop event carries it. */
export function file(name: string): File {
  return new File(['x'], name);
}
