import { type Channel, StandardChannel, sampleAt } from '../model/telemetry.js';
import type { RawSamples, ValueContext, ValueInfo, ValueOutput } from './types.js';

export interface BuiltinValue {
  info: Omit<ValueInfo, 'origin' | 'initial'> & { initial?: number | null };
  compute(ctx: ValueContext): ValueOutput;
}

function map(values: Float64Array, fn: (value: number, index: number) => number): Float64Array {
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = fn(values[i] as number, i);
  return out;
}

function fromTimes(ctx: ValueContext, fn: (time: number) => number): Float64Array {
  return map(ctx.times, (t) => fn(t));
}

const EARTH_RADIUS = 6_371_000;
/** Below this GPS speed (m/s) position changes are jitter, not movement. */
const STANDSTILL_SPEED = 1;
/** Above this implied speed (m/s) a position jump is a GPS glitch. */
const GLITCH_SPEED = 150;

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Raw GPS positions of one source kind (mixing devices would zig-zag), null without GPS. */
export function gpsSamples(
  ctx: ValueContext,
): { kind: string; latitude: RawSamples; longitude: RawSamples } | null {
  const kind = ['racechrono', 'dji', 'gopro'].find(
    (k) => ctx.has(`${k}.latitude`) && ctx.has(`${k}.longitude`),
  );
  const latitude = kind ? ctx.raw(`${kind}.latitude`) : null;
  const longitude = kind ? ctx.raw(`${kind}.longitude`) : null;
  if (!kind || !latitude || !longitude || latitude.time.length !== longitude.time.length) return null;
  return { kind, latitude, longitude };
}

/**
 * Cumulative distance from the GPS positions, skipping standstill jitter and glitches, sampled at
 * the frame times.
 */
export function gpsDistance(ctx: ValueContext): Float64Array | null {
  const gps = gpsSamples(ctx);
  if (!gps || gps.latitude.time.length < 2) return null;
  const { kind, latitude: lat, longitude: lon } = gps;
  const speedRaw = ctx.raw(`${kind}.speed`);
  const speed: Channel | null = speedRaw ? { key: 'speed', label: '', unit: 'm/s', ...speedRaw } : null;

  const n = lat.time.length;
  const cumulative = new Float64Array(n);
  let total = 0;
  let previous = -1;
  for (let i = 0; i < n; i++) {
    const la = lat.values[i] as number;
    const lo = lon.values[i] as number;
    if (!Number.isFinite(la) || !Number.isFinite(lo) || (la === 0 && lo === 0)) {
      cumulative[i] = total;
      continue;
    }
    if (previous >= 0) {
      const d = haversine(lat.values[previous] as number, lon.values[previous] as number, la, lo);
      const dt = (lat.time[i] as number) - (lat.time[previous] as number);
      const midSpeed = speed
        ? sampleAt(speed, ((lat.time[i] as number) + (lat.time[previous] as number)) / 2)
        : d / dt;
      const moving = Number.isNaN(midSpeed) ? d / dt >= STANDSTILL_SPEED : midSpeed >= STANDSTILL_SPEED;
      if (dt > 0 && moving && d / dt < GLITCH_SPEED) total += d;
    }
    cumulative[i] = total;
    previous = i;
  }
  const channel: Channel = { key: 'distance', label: '', unit: 'm', time: lat.time, values: cumulative };
  return ctx.times.map((t) => sampleAt(channel, t, { maxGapSeconds: Number.POSITIVE_INFINITY }));
}

const GRAVITY = 9.80665;
/** Half window (s) of the GPS derivatives: smooths 10 Hz GPS noise and keeps the shape of corners. */
const DERIVATIVE_HALF_WINDOW = 0.4;
/** GPS derived accelerations beyond this (g) are position glitches. */
const MAX_GPS_G = 5;
/** Below this speed (m/s, ~11 km/h) GPS jitter looks like sharp turns: no cornering G. */
const MIN_CORNERING_SPEED = 3;
/** Below this move (m) between neighbouring fixes the course is noise: keep the previous one. */
const MIN_COURSE_MOVE = 0.5;

const gpsAccelerationCache = new WeakMap<
  ValueContext,
  { longitudinal: Float64Array; lateral: Float64Array } | null
>();

/**
 * Longitudinal and lateral acceleration (g) from the GPS track, sampled at the frame times: the
 * change of speed, and the speed times the turn rate of the course. Unlike a camera IMU it does
 * not depend on how the camera is mounted. Positive longitudinal is speeding up, positive lateral
 * is turning right.
 */
export function gpsAccelerations(
  ctx: ValueContext,
): { longitudinal: Float64Array; lateral: Float64Array } | null {
  if (gpsAccelerationCache.has(ctx)) return gpsAccelerationCache.get(ctx) ?? null;
  const result = computeGpsAccelerations(ctx);
  gpsAccelerationCache.set(ctx, result);
  return result;
}

function computeGpsAccelerations(
  ctx: ValueContext,
): { longitudinal: Float64Array; lateral: Float64Array } | null {
  const gps = gpsSamples(ctx);
  if (!gps) return null;
  const { kind, latitude: lat, longitude: lon } = gps;
  const fixes: number[] = [];
  for (let i = 0; i < lat.time.length; i++) {
    const la = lat.values[i] as number;
    const lo = lon.values[i] as number;
    if (Number.isFinite(la) && Number.isFinite(lo) && !(la === 0 && lo === 0)) fixes.push(i);
  }
  const n = fixes.length;
  if (n < 3) return null;

  // Local meters, x east and y north.
  const lat0 = lat.values[fixes[0] as number] as number;
  const lon0 = lon.values[fixes[0] as number] as number;
  const k = (Math.PI / 180) * EARTH_RADIUS;
  const cos0 = Math.cos(lat0 * (Math.PI / 180));
  const time = Float64Array.from(fixes, (i) => lat.time[i] as number);
  const xs = Float64Array.from(fixes, (i) => ((lon.values[i] as number) - lon0) * k * cos0);
  const ys = Float64Array.from(fixes, (i) => ((lat.values[i] as number) - lat0) * k);

  // Doppler speed when logged (smoother than position differences).
  const speedRaw = ctx.raw(`${kind}.speed`);
  const speedChannel: Channel | null = speedRaw
    ? { key: 'speed', label: '', unit: 'm/s', ...speedRaw }
    : null;
  const speed = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    const a = Math.max(0, j - 1);
    const b = Math.min(n - 1, j + 1);
    const fromPositions =
      Math.hypot((xs[b] as number) - (xs[a] as number), (ys[b] as number) - (ys[a] as number)) /
      ((time[b] as number) - (time[a] as number));
    const logged = speedChannel ? sampleAt(speedChannel, time[j] as number) : Number.NaN;
    speed[j] = Number.isFinite(logged) ? logged : fromPositions;
  }

  // Course over ground (radians clockwise from north), unwrapped so turn rates have no jumps.
  const course = new Float64Array(n).fill(Number.NaN);
  let unwrapped = Number.NaN;
  let previous = Number.NaN;
  for (let j = 0; j < n; j++) {
    const a = Math.max(0, j - 1);
    const b = Math.min(n - 1, j + 1);
    const dx = (xs[b] as number) - (xs[a] as number);
    const dy = (ys[b] as number) - (ys[a] as number);
    if (Math.hypot(dx, dy) >= MIN_COURSE_MOVE) {
      const raw = Math.atan2(dx, dy);
      if (Number.isNaN(previous)) {
        unwrapped = raw;
      } else {
        let turn = raw - previous;
        while (turn > Math.PI) turn -= 2 * Math.PI;
        while (turn < -Math.PI) turn += 2 * Math.PI;
        unwrapped += turn;
      }
      previous = raw;
    }
    course[j] = unwrapped;
  }

  const longitudinal = new Float64Array(n);
  const lateral = new Float64Array(n);
  let a = 0;
  let b = 0;
  for (let j = 0; j < n; j++) {
    const t = time[j] as number;
    while ((time[a] as number) < t - DERIVATIVE_HALF_WINDOW) a++;
    while (b + 1 < n && (time[b + 1] as number) <= t + DERIVATIVE_HALF_WINDOW) b++;
    const dt = (time[b] as number) - (time[a] as number);
    const along = dt > 0 ? ((speed[b] as number) - (speed[a] as number)) / dt / GRAVITY : Number.NaN;
    const across =
      dt > 0
        ? ((speed[j] as number) * ((course[b] as number) - (course[a] as number))) / dt / GRAVITY
        : Number.NaN;
    longitudinal[j] = Math.abs(along) <= MAX_GPS_G ? along : Number.NaN;
    if ((speed[j] as number) < MIN_CORNERING_SPEED) lateral[j] = 0;
    else lateral[j] = Math.abs(across) <= MAX_GPS_G ? across : Number.NaN;
  }
  const atFrames = (values: Float64Array) => {
    const channel: Channel = { key: 'accel', label: '', unit: 'g', time, values };
    return ctx.times.map((t) => sampleAt(channel, t));
  };
  return { longitudinal: atFrames(longitudinal), lateral: atFrames(lateral) };
}

const KMH = 3.6;
const MPH = 2.236936;

/**
 * Highest speed so far, in the unit of `speed` (`factor` converts it from m/s). A frame whose speed
 * changed faster than MAX_GPS_G since the last accepted frame is a GPS spike and is ignored, so one
 * bad sample can't stick as the top speed for the rest of the session.
 */
function topSpeed(ctx: ValueContext, speed: Float64Array, factor: number): Float64Array {
  const maxChange = MAX_GPS_G * GRAVITY * factor;
  let top = Number.NaN;
  let lastValue = Number.NaN;
  let lastTime = Number.NaN;
  return map(speed, (v, i) => {
    if (Number.isNaN(v)) return top;
    const t = ctx.times[i] as number;
    if (!Number.isNaN(lastValue) && Math.abs(v - lastValue) > maxChange * (t - lastTime)) return top;
    lastValue = v;
    lastTime = t;
    if (Number.isNaN(top) || v > top) top = v;
    return top;
  });
}

export const BUILTIN_VALUES: readonly BuiltinValue[] = [
  {
    info: {
      id: 'time.timeline',
      name: 'Timeline time',
      description: 'Seconds since timeline time 0',
      unit: 's',
    },
    compute: (ctx) => ctx.times,
  },
  {
    info: {
      id: 'time.frame',
      name: 'Frame number',
      description: 'Index of the frame being rendered',
      unit: '',
    },
    compute: (ctx) => map(ctx.times, (_, i) => i),
  },
  {
    info: {
      id: 'time.clock',
      name: 'Clock time',
      description: 'UTC time of the frame as epoch milliseconds (from GPS or the logger clock)',
      unit: 'ms',
    },
    compute: (ctx) =>
      ctx.startEpochMs === null ? null : fromTimes(ctx, (t) => (ctx.startEpochMs as number) + t * 1000),
  },
  {
    info: {
      id: 'session.elapsed',
      name: 'Session elapsed',
      description: 'Seconds since the start of the data (the timeline, or the data range)',
      unit: 's',
    },
    compute: (ctx) => fromTimes(ctx, (t) => t - Math.max(ctx.start, ctx.range.start)),
  },
  {
    info: {
      id: 'session.remaining',
      name: 'Session time left',
      description: 'Seconds until the end of the data (the timeline, or the data range)',
      unit: 's',
    },
    compute: (ctx) => {
      const end = Math.min(ctx.start + (ctx.frameCount - 1) / ctx.frameRate, ctx.range.end);
      return fromTimes(ctx, (t) => end - t);
    },
  },
  {
    info: {
      id: 'speed.kmh',
      name: 'Speed (km/h)',
      description: 'Best available speed in km/h',
      unit: 'km/h',
    },
    compute: (ctx) =>
      ctx.has(StandardChannel.speed) ? map(ctx.get(StandardChannel.speed), (v) => v * KMH) : null,
  },
  {
    info: { id: 'speed.mph', name: 'Speed (mph)', description: 'Best available speed in mph', unit: 'mph' },
    compute: (ctx) =>
      ctx.has(StandardChannel.speed) ? map(ctx.get(StandardChannel.speed), (v) => v * MPH) : null,
  },
  {
    info: {
      id: 'speed.top.kmh',
      name: 'Top speed (km/h)',
      description: 'Highest speed so far in km/h, ignoring GPS spikes',
      unit: 'km/h',
    },
    compute: (ctx) => (ctx.has(StandardChannel.speed) ? topSpeed(ctx, ctx.get('speed.kmh'), KMH) : null),
  },
  {
    info: {
      id: 'speed.top.mph',
      name: 'Top speed (mph)',
      description: 'Highest speed so far in mph, ignoring GPS spikes',
      unit: 'mph',
    },
    compute: (ctx) => (ctx.has(StandardChannel.speed) ? topSpeed(ctx, ctx.get('speed.mph'), MPH) : null),
  },
  {
    info: {
      id: 'accel.lateral',
      name: 'Lateral G',
      description:
        'Cornering acceleration: logged lateral G, or computed from the GPS track (positive = turning right)',
      unit: 'g',
    },
    compute: (ctx) =>
      ctx.has(StandardChannel.accelLateral)
        ? ctx.get(StandardChannel.accelLateral)
        : (gpsAccelerations(ctx)?.lateral ?? null),
  },
  {
    info: {
      id: 'accel.longitudinal',
      name: 'Longitudinal G',
      description:
        'Acceleration and braking: logged longitudinal G, or computed from the GPS speed (positive = speeding up)',
      unit: 'g',
    },
    compute: (ctx) =>
      ctx.has(StandardChannel.accelLongitudinal)
        ? ctx.get(StandardChannel.accelLongitudinal)
        : (gpsAccelerations(ctx)?.longitudinal ?? null),
  },
  {
    info: {
      id: 'accel.combined',
      name: 'Combined G',
      description: 'Total horizontal acceleration: logged value, or computed from lateral and longitudinal G',
      unit: 'g',
    },
    compute: (ctx) => {
      if (ctx.has(StandardChannel.accelCombined)) return ctx.get(StandardChannel.accelCombined);
      const lateral = ctx.get('accel.lateral');
      const longitudinal = ctx.get('accel.longitudinal');
      return map(lateral, (v, i) => Math.hypot(v, longitudinal[i] as number));
    },
  },
  {
    info: {
      id: 'distance.traveled',
      name: 'Distance traveled',
      description:
        'Meters covered since the start of the data: logged distance, or integrated from GPS positions while moving',
      unit: 'm',
    },
    compute: (ctx) => {
      const distance = ctx.has(StandardChannel.distance)
        ? ctx.get(StandardChannel.distance)
        : gpsDistance(ctx);
      if (!distance || ctx.range.start === Number.NEGATIVE_INFINITY) return distance;
      // From 0 at the start of the data range.
      const first = ctx.times.findIndex((t) => t >= ctx.range.start);
      const origin = first >= 0 ? distance.slice(first).find((v) => Number.isFinite(v)) : undefined;
      return origin === undefined ? distance : distance.map((v) => v - origin);
    },
  },
];
