import type { VideoInfo } from '../../src/media/probe.js';
import type { Channel, TelemetrySeries } from '../../src/model/telemetry.js';

export function videoInfo(overrides: Partial<VideoInfo> = {}): VideoInfo {
  return {
    path: '/v.mp4',
    fileName: 'v.mp4',
    sizeBytes: 1,
    durationSeconds: 60,
    width: 3840,
    height: 2160,
    frameRate: 59.94,
    frameCount: 3596,
    codec: 'hvc1',
    creationTime: null,
    hasGpmf: true,
    hasAudio: true,
    color: { space: 'rec709', range: 'full', bitDepth: 10 },
    camera: { model: null, firmware: null },
    clock: [],
    ...overrides,
  };
}

/** Deterministic pseudo random value in [-1, 1] for an integer. */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/** Smooth value noise with a feature every 3 seconds. */
function noise(t: number): number {
  const i = Math.floor(t / 3);
  const f = t / 3 - i;
  const s = f * f * (3 - 2 * f);
  return hash(i) * (1 - s) + hash(i + 1) * s;
}

/** Speed profile of a session: smooth and never repeating, so a match is unique. */
export function speedAt(t: number): number {
  return 30 + 6 * Math.sin(t / 7) + 8 * noise(t);
}

/** Speed channel sampling the session profile from `start`, for `duration` seconds. */
export function speedChannel(start: number, duration: number, rate: number, profile = speedAt): Channel {
  const n = Math.floor(duration * rate);
  const time = new Float64Array(n);
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    time[i] = i / rate;
    values[i] = profile(start + i / rate);
  }
  return { key: 'speed', label: 'Speed', unit: 'm/s', time, values };
}

export function speedSeries(
  start: number,
  duration: number,
  rate: number,
  startEpochMs: number | null,
  kind: TelemetrySeries['kind'] = 'racechrono',
): TelemetrySeries {
  return { kind, name: 'test', startEpochMs, channels: [speedChannel(start, duration, rate)], metadata: {} };
}
