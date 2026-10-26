/** Kinds of telemetry sources the engine knows how to read. */
export type SourceKind = 'gopro' | 'racechrono' | 'dji';

/**
 * Well-known channel keys. Parsers map their native columns to these keys so widgets can be
 * written once and work with any source. Unknown columns keep a sanitized native key.
 */
export const StandardChannel = {
  latitude: 'latitude',
  longitude: 'longitude',
  altitude: 'altitude',
  /** Ground speed in m/s. */
  speed: 'speed',
  speed3d: 'speed3d',
  heading: 'heading',
  distance: 'distance',
  lap: 'lap',
  elapsedTime: 'elapsedTime',
  satellites: 'satellites',
  gpsAccuracy: 'gpsAccuracy',
  gpsFix: 'gpsFix',
  /** Accelerations in G. */
  accelLateral: 'accelLateral',
  accelLongitudinal: 'accelLongitudinal',
  accelVertical: 'accelVertical',
  accelCombined: 'accelCombined',
  accelX: 'accelX',
  accelY: 'accelY',
  accelZ: 'accelZ',
  /** Rotation rates in rad/s. */
  gyroX: 'gyroX',
  gyroY: 'gyroY',
  gyroZ: 'gyroZ',
  leanAngle: 'leanAngle',
} as const;

export type StandardChannelKey = (typeof StandardChannel)[keyof typeof StandardChannel];

/**
 * A single measured quantity. Every channel carries its own time axis because sensors are sampled
 * at different rates (GPS at 10-18 Hz, IMU at 200 Hz...). Channels from the same sensor share the
 * same `time` array instance.
 */
export interface Channel {
  key: string;
  label: string;
  unit: string;
  /** Sample times in seconds, relative to the series origin, ascending. */
  time: Float64Array;
  values: Float64Array;
}

/** Telemetry loaded from one source (a GoPro file, a RaceChrono export...). */
export interface TelemetrySeries {
  kind: SourceKind;
  name: string;
  /** UTC epoch milliseconds corresponding to `time = 0`, when the source knows absolute time. */
  startEpochMs: number | null;
  channels: Channel[];
  metadata: Record<string, string>;
}

export interface ChannelSummary {
  key: string;
  label: string;
  unit: string;
  samples: number;
  rateHz: number;
  min: number;
  max: number;
}

export interface SeriesSummary {
  name: string;
  kind: SourceKind;
  startTime: string | null;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  channels: ChannelSummary[];
}

export function getChannel(series: TelemetrySeries, key: string): Channel | undefined {
  return series.channels.find((c) => c.key === key);
}

/** Time range covered by all channels of a series, in series seconds. */
export function seriesTimeRange(series: TelemetrySeries): { start: number; end: number } {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const channel of series.channels) {
    const n = channel.time.length;
    if (n === 0) continue;
    start = Math.min(start, channel.time[0] as number);
    end = Math.max(end, channel.time[n - 1] as number);
  }
  if (!Number.isFinite(start)) return { start: 0, end: 0 };
  return { start, end };
}

/** Index of the last sample whose time is <= t, or -1 when t is before the first sample. */
export function findSampleIndex(time: Float64Array, t: number): number {
  let lo = 0;
  let hi = time.length - 1;
  if (hi < 0 || t < (time[0] as number)) return -1;
  if (t >= (time[hi] as number)) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((time[mid] as number) <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface SampleOptions {
  /** Interpolate linearly between samples (default) or hold the previous value. */
  interpolate?: boolean;
  /** Return NaN when t is further than this many seconds from any sample. Default 1s. */
  maxGapSeconds?: number;
}

/** Value of a channel at time t (series seconds). Returns NaN outside of the channel range. */
export function sampleAt(channel: Channel, t: number, options: SampleOptions = {}): number {
  const { interpolate = true, maxGapSeconds = 1 } = options;
  const { time, values } = channel;
  const i = findSampleIndex(time, t);
  if (i < 0) return Number.NaN;
  const t0 = time[i] as number;
  const v0 = values[i] as number;
  if (i === time.length - 1) return t - t0 <= maxGapSeconds ? v0 : Number.NaN;
  const t1 = time[i + 1] as number;
  const v1 = values[i + 1] as number;
  if (t1 - t0 > maxGapSeconds && t - t0 > maxGapSeconds && t1 - t > maxGapSeconds) {
    return Number.NaN;
  }
  if (!interpolate || t1 === t0) return v0;
  return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
}

/** Resample a channel onto a uniform grid; gaps become NaN. */
export function resampleUniform(channel: Channel, start: number, end: number, rateHz: number): Float64Array {
  const count = Math.max(0, Math.floor((end - start) * rateHz) + 1);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) out[i] = sampleAt(channel, start + i / rateHz);
  return out;
}

export function summarizeChannel(channel: Channel): ChannelSummary {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of channel.values) {
    if (Number.isNaN(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const n = channel.time.length;
  const span = n > 1 ? (channel.time[n - 1] as number) - (channel.time[0] as number) : 0;
  return {
    key: channel.key,
    label: channel.label,
    unit: channel.unit,
    samples: n,
    rateHz: span > 0 ? (n - 1) / span : 0,
    min: Number.isFinite(min) ? min : Number.NaN,
    max: Number.isFinite(max) ? max : Number.NaN,
  };
}

export function summarizeSeries(series: TelemetrySeries): SeriesSummary {
  const { start, end } = seriesTimeRange(series);
  return {
    name: series.name,
    kind: series.kind,
    startTime:
      series.startEpochMs === null ? null : new Date(series.startEpochMs + start * 1000).toISOString(),
    startSeconds: start,
    endSeconds: end,
    durationSeconds: end - start,
    channels: series.channels.map(summarizeChannel),
  };
}
