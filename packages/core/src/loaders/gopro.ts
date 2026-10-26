import { GoProTelemetry } from 'gopro-telemetry';
import type { GpmfTrackData } from '../media/probe.js';
import { type Channel, StandardChannel, type TelemetrySeries } from '../model/telemetry.js';

const STANDARD_GRAVITY = 9.80665;

interface GoProSample {
  cts: number;
  date?: Date | string;
  value: number | number[];
  sticky?: Record<string, unknown>;
}

interface GoProStream {
  name?: string;
  units?: string | string[];
  samples: GoProSample[];
}

type GoProDevices = Record<string, { 'device name'?: string; streams?: Record<string, GoProStream> }>;

interface AxisSpec {
  key: string;
  label: string;
  unit: string;
  scale?: number;
}

function streamTime(stream: GoProStream): Float64Array {
  return new Float64Array(stream.samples.map((s) => s.cts / 1000));
}

/** False for samples recorded without a GPS lock (fix < 2). GPS9 carries the fix, GPS5 a sticky. */
function gpsFixMask(stream: GoProStream, gps9: boolean): boolean[] {
  let fix: number | undefined;
  return stream.samples.map((s) => {
    if (gps9 && Array.isArray(s.value)) fix = s.value[8];
    else if (typeof s.sticky?.fix === 'number') fix = s.sticky.fix;
    return fix === undefined || fix >= 2;
  });
}

function axisChannels(
  stream: GoProStream,
  time: Float64Array,
  axes: AxisSpec[],
  valid?: boolean[],
): Channel[] {
  return axes.map((axis, index) => {
    const scale = axis.scale ?? 1;
    const values = new Float64Array(stream.samples.length);
    stream.samples.forEach((s, i) => {
      const v = Array.isArray(s.value) ? s.value[index] : index === 0 ? s.value : undefined;
      values[i] = typeof v === 'number' && valid?.[i] !== false ? v * scale : Number.NaN;
    });
    return { key: axis.key, label: axis.label, unit: axis.unit, time, values };
  });
}

const GPS_AXES: AxisSpec[] = [
  { key: StandardChannel.latitude, label: 'Latitude', unit: 'deg' },
  { key: StandardChannel.longitude, label: 'Longitude', unit: 'deg' },
  { key: StandardChannel.altitude, label: 'Altitude', unit: 'm' },
  { key: StandardChannel.speed, label: 'Speed (2D)', unit: 'm/s' },
  { key: StandardChannel.speed3d, label: 'Speed (3D)', unit: 'm/s' },
];

function imuAxes(streamName: string, kind: 'accel' | 'gyro'): AxisSpec[] {
  const unit = kind === 'accel' ? 'g' : 'rad/s';
  const scale = kind === 'accel' ? 1 / STANDARD_GRAVITY : 1;
  const label = kind === 'accel' ? 'Acceleration' : 'Rotation rate';
  if (kind === 'accel' && /up\/down/i.test(streamName)) {
    return [
      { key: StandardChannel.accelVertical, label: `${label} up/down`, unit, scale },
      { key: StandardChannel.accelLateral, label: `${label} right/left`, unit, scale },
      { key: StandardChannel.accelLongitudinal, label: `${label} forward/back`, unit, scale },
    ];
  }
  // Older cameras report axes in (z, x, y) order.
  const prefix = kind === 'accel' ? 'accel' : 'gyro';
  return ['Z', 'X', 'Y'].map((axis) => ({
    key: `${prefix}${axis}`,
    label: `${label} ${axis.toLowerCase()}`,
    unit,
    scale,
  }));
}

/** Median of (GPS date - cts) over locked samples: the UTC instant of video time 0. */
function videoStartFromGps(stream: GoProStream | undefined, valid: boolean[]): number | null {
  if (!stream) return null;
  const deltas: number[] = [];
  for (const [i, s] of stream.samples.entries()) {
    if (!s.date || !valid[i]) continue;
    const ms = new Date(s.date).getTime();
    if (Number.isFinite(ms) && ms > 0) deltas.push(ms - s.cts);
  }
  if (deltas.length === 0) return null;
  deltas.sort((a, b) => a - b);
  return Math.round(deltas[Math.floor(deltas.length / 2)] as number);
}

/** Convert the output of gopro-telemetry into a normalized series. Exported for tests. */
export function goproDevicesToSeries(devices: GoProDevices, name: string): TelemetrySeries | null {
  const channels: Channel[] = [];
  const metadata: Record<string, string> = {};
  let gpsStream: GoProStream | undefined;
  let gpsValid: boolean[] = [];

  for (const device of Object.values(devices)) {
    const streams = device.streams ?? {};
    if (device['device name']) metadata.device = device['device name'];
    const gps = streams.GPS9 ?? streams.GPS5;
    if (gps && gps.samples.length > 0 && !gpsStream) {
      gpsStream = gps;
      gpsValid = gpsFixMask(gps, gps === streams.GPS9);
      channels.push(...axisChannels(gps, streamTime(gps), GPS_AXES, gpsValid));
    }
    const accl = streams.ACCL;
    if (accl && accl.samples.length > 0) {
      channels.push(...axisChannels(accl, streamTime(accl), imuAxes(accl.name ?? '', 'accel')));
    }
    const gyro = streams.GYRO;
    if (gyro && gyro.samples.length > 0) {
      channels.push(...axisChannels(gyro, streamTime(gyro), imuAxes(gyro.name ?? '', 'gyro')));
    }
  }
  if (channels.length === 0) return null;
  return { kind: 'gopro', name, startEpochMs: videoStartFromGps(gpsStream, gpsValid), channels, metadata };
}

/**
 * Parse GoPro GPMF data. Channel times are video times (seconds from the first frame), so the
 * embedded telemetry is always in sync with its own video.
 */
export async function parseGoProTelemetry(
  gpmf: GpmfTrackData,
  name: string,
): Promise<TelemetrySeries | null> {
  const result = await GoProTelemetry(
    { rawData: gpmf.rawData, timing: gpmf.timing },
    { stream: ['GPS', 'ACCL', 'GYRO'] },
  );
  return goproDevicesToSeries(result as unknown as GoProDevices, name);
}
