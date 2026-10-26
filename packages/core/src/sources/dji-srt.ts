import { type Channel, StandardChannel, type TelemetrySeries } from '../model/telemetry.js';

/**
 * Parser for the telemetry subtitles DJI drones and cameras write next to their videos
 * (`DJI_0001.MP4` + `DJI_0001.SRT`). Every subtitle covers one video frame (or a fixed step) and
 * holds GPS, altitude and camera settings in one of a few layouts:
 *
 *   [latitude: 59.302335] [longitude: 18.203059] [rel_alt: 1.300 abs_alt: 132.860] [iso : 2700]
 *   GPS(39.906217,116.391305,69.800) BAROMETER(91.2) HOME(39.906206,116.391400)
 *   GPS (-58.851745, -34.237922, 15), D 12.3m, H 4.5m, H.S 3.2m/s, V.S 0.0m/s, F/5.6, SS 400
 *   <font size="28">FrameCnt: 1, DiffTime: 16ms\n2026-08-23 17:22:01.253\n[iso: 160] ...</font>
 *
 * Subtitle times are video times, so the series is always in sync with its video.
 */

export class DjiSrtParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DjiSrtParseError';
  }
}

interface ChannelSpec {
  key: string;
  label: string;
  unit: string;
}

/** Channels a subtitle can fill, by field name. */
const CHANNELS = {
  latitude: { key: StandardChannel.latitude, label: 'Latitude', unit: 'deg' },
  longitude: { key: StandardChannel.longitude, label: 'Longitude', unit: 'deg' },
  altitude: { key: StandardChannel.altitude, label: 'Altitude', unit: 'm' },
  relAltitude: { key: 'relativeAltitude', label: 'Height above takeoff', unit: 'm' },
  barometer: { key: 'barometerAltitude', label: 'Barometric altitude', unit: 'm' },
  homeLatitude: { key: 'homeLatitude', label: 'Home latitude', unit: 'deg' },
  homeLongitude: { key: 'homeLongitude', label: 'Home longitude', unit: 'deg' },
  homeDistance: { key: 'homeDistance', label: 'Distance from home', unit: 'm' },
  height: { key: 'height', label: 'Height', unit: 'm' },
  speed: { key: StandardChannel.speed, label: 'Horizontal speed', unit: 'm/s' },
  verticalSpeed: { key: 'verticalSpeed', label: 'Vertical speed', unit: 'm/s' },
  iso: { key: 'iso', label: 'ISO', unit: '' },
  shutter: { key: 'shutter', label: 'Shutter time', unit: 's' },
  fNumber: { key: 'fNumber', label: 'Aperture', unit: 'f/' },
  ev: { key: 'ev', label: 'Exposure compensation', unit: 'EV' },
  colorTemperature: { key: 'colorTemperature', label: 'White balance', unit: 'K' },
  focalLength: { key: 'focalLength', label: 'Focal length', unit: 'mm' },
  digitalZoom: { key: 'digitalZoom', label: 'Digital zoom', unit: 'x' },
  gimbalYaw: { key: 'gimbalYaw', label: 'Gimbal yaw', unit: 'deg' },
  gimbalPitch: { key: 'gimbalPitch', label: 'Gimbal pitch', unit: 'deg' },
  gimbalRoll: { key: 'gimbalRoll', label: 'Gimbal roll', unit: 'deg' },
  aircraftYaw: { key: 'aircraftYaw', label: 'Aircraft yaw', unit: 'deg' },
  aircraftPitch: { key: 'aircraftPitch', label: 'Aircraft pitch', unit: 'deg' },
  aircraftRoll: { key: 'aircraftRoll', label: 'Aircraft roll', unit: 'deg' },
} satisfies Record<string, ChannelSpec>;

type Field = keyof typeof CHANNELS;
type Sample = Partial<Record<Field, number>>;

/** Bracketed `[key: value]` names (DJI spellings, including the old `longtitude`) to fields. */
const BRACKET_FIELDS: Record<string, Field> = {
  latitude: 'latitude',
  longitude: 'longitude',
  longtitude: 'longitude',
  rel_alt: 'relAltitude',
  abs_alt: 'altitude',
  altitude: 'altitude',
  iso: 'iso',
  shutter: 'shutter',
  fnum: 'fNumber',
  ev: 'ev',
  ct: 'colorTemperature',
  focal_len: 'focalLength',
  dzoom_ratio: 'digitalZoom',
  gb_yaw: 'gimbalYaw',
  gb_pitch: 'gimbalPitch',
  gb_roll: 'gimbalRoll',
};

const NUMBER = String.raw`-?\d+(?:\.\d+)?`;

/** `1/640.0` → 0.0015625; plain numbers as they are. */
function parseValue(text: string): number {
  const [a, b] = text.split('/');
  if (b !== undefined) return Number(a) / Number(b);
  return Number(text);
}

/**
 * Values in the field's unit. Older firmwares write the f-number ×100 (`170` = f/1.7) and the
 * focal length ×10 (`240` = 24 mm) as integers; newer ones write decimals (`1.7`, `24.00`).
 */
function normalize(field: Field, raw: string): number {
  const value = parseValue(raw);
  if (field === 'fNumber' && !raw.includes('.')) return value / 100;
  if (field === 'focalLength' && !raw.includes('.')) return value / 10;
  return value;
}

/** Fields of one subtitle's text (tags and line breaks already removed). */
export function parseDjiSubtitle(text: string): { sample: Sample; clock: string | null } {
  const sample: Sample = {};
  const set = (field: Field, value: number) => {
    if (Number.isFinite(value)) sample[field] = value;
  };

  for (const bracket of text.matchAll(/\[([^[\]]*)\]/g)) {
    const content = bracket[1] ?? '';
    for (const pair of content.matchAll(
      new RegExp(String.raw`([A-Za-z_]+)\s*:\s*(${NUMBER}(?:\/${NUMBER})?)`, 'g'),
    )) {
      const field = BRACKET_FIELDS[(pair[1] ?? '').toLowerCase()];
      if (field) set(field, normalize(field, pair[2] ?? ''));
    }
  }

  const tuple = (name: string, count: number) => {
    const parts = Array.from({ length: count }, () => `(${NUMBER})°?[A-Za-z]*`).join(String.raw`\s*,\s*`);
    return new RegExp(String.raw`${name}\s*\(\s*${parts}\s*\)`).exec(text);
  };
  const gps = tuple('GPS', 3) ?? tuple('GPS', 2);
  if (gps) {
    set('latitude', Number(gps[1]));
    set('longitude', Number(gps[2]));
    if (gps[3] !== undefined) set('altitude', Number(gps[3]));
  }
  const home = tuple('HOME', 2);
  if (home) {
    set('homeLatitude', Number(home[1]));
    set('homeLongitude', Number(home[2]));
  }
  const barometer = new RegExp(String.raw`BAROMETER\s*[(:]\s*(${NUMBER})`).exec(text);
  if (barometer) set('barometer', Number(barometer[1]));
  const measure = (pattern: string) =>
    new RegExp(String.raw`(?:^|[\s,])${pattern}\s*[=:]?\s*(${NUMBER})`).exec(text);
  const distance = measure('D');
  if (distance) set('homeDistance', Number(distance[1]));
  const height = measure(String.raw`H(?!\.)`);
  if (height) set('height', Number(height[1]));
  const horizontal = measure(String.raw`H\.S`);
  if (horizontal) set('speed', Number(horizontal[1]));
  const vertical = measure(String.raw`V\.S`);
  if (vertical) set('verticalSpeed', Number(vertical[1]));
  const aircraft = tuple(String.raw`F\.PRY`, 3);
  if (aircraft) {
    set('aircraftPitch', Number(aircraft[1]));
    set('aircraftRoll', Number(aircraft[2]));
    set('aircraftYaw', Number(aircraft[3]));
  }
  const gimbal = tuple(String.raw`G\.PRY`, 3);
  if (gimbal) {
    set('gimbalPitch', Number(gimbal[1]));
    set('gimbalRoll', Number(gimbal[2]));
    set('gimbalYaw', Number(gimbal[3]));
  }
  // Compact camera fields: F/5.6, SS 400 (1/400 s), ISO 100, EV 0.
  const aperture = new RegExp(String.raw`\bF\/(${NUMBER})`).exec(text);
  if (aperture && sample.fNumber === undefined) set('fNumber', Number(aperture[1]));
  const shutter = new RegExp(String.raw`\bSS\s+(${NUMBER})`).exec(text);
  if (shutter && sample.shutter === undefined) set('shutter', 1 / Number(shutter[1]));
  const iso = new RegExp(String.raw`\bISO\s+(${NUMBER})`).exec(text);
  if (iso && sample.iso === undefined) set('iso', Number(iso[1]));
  const ev = new RegExp(String.raw`\bEV\s+(${NUMBER})`).exec(text);
  if (ev && sample.ev === undefined) set('ev', Number(ev[1]));

  // Without a GPS fix DJI writes 0, 0.
  if (sample.latitude === 0 && sample.longitude === 0) {
    delete sample.latitude;
    delete sample.longitude;
  }
  const clock = /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)/.exec(text);
  return { sample, clock: clock?.[1] ?? null };
}

/** Whether a text looks like DJI telemetry subtitles. */
export function isDjiSrt(text: string): boolean {
  const head = text.slice(0, 4000);
  return /-->/.test(head) && /(latitude|longtitude|GPS\s*\(|FrameCnt|SrtCnt|abs_alt|rel_alt)/i.test(head);
}

const EARTH_RADIUS = 6_371_000;
/** Half window (s) of the speed computed from positions. */
const SPEED_HALF_WINDOW = 0.5;

/** Ground speed (m/s) from the positions, over ±0.5 s, for files without a speed field. */
function speedFromPositions(time: Float64Array, lat: Float64Array, lon: Float64Array): Float64Array {
  const n = time.length;
  const out = new Float64Array(n).fill(Number.NaN);
  const rad = Math.PI / 180;
  let a = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    const t = time[i] as number;
    while ((time[a] as number) < t - SPEED_HALF_WINDOW) a++;
    while (b + 1 < n && (time[b + 1] as number) <= t + SPEED_HALF_WINDOW) b++;
    const la1 = lat[a] as number;
    const lo1 = lon[a] as number;
    const la2 = lat[b] as number;
    const lo2 = lon[b] as number;
    const dt = (time[b] as number) - (time[a] as number);
    if (!(dt > 0) || ![la1, lo1, la2, lo2].every(Number.isFinite)) continue;
    const dLat = (la2 - la1) * rad;
    const dLon = (lo2 - lo1) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dLon / 2) ** 2;
    out[i] = (2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)))) / dt;
  }
  return out;
}

/** Seconds of an SRT time `HH:MM:SS,mmm`. */
function srtSeconds(text: string): number {
  const match = /(?<!\d)(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(text);
  if (!match) return Number.NaN;
  const [, h, m, s, ms] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number((ms ?? '0').padEnd(3, '0')) / 1000;
}

/** Parse DJI telemetry subtitles into a series on the video's time axis. */
export function parseDjiSrt(text: string, name: string): TelemetrySeries {
  const times: number[] = [];
  const samples: Sample[] = [];
  let firstClock: string | null = null;
  for (const block of text.replace(/^﻿/, '').split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const timeLine = lines.findIndex((line) => line.includes('-->'));
    if (timeLine < 0) continue;
    const time = srtSeconds(lines[timeLine] ?? '');
    if (!Number.isFinite(time)) continue;
    const body = lines
      .slice(timeLine + 1)
      .join(' ')
      .replace(/<[^<>]*>/g, ' ');
    const { sample, clock } = parseDjiSubtitle(body);
    firstClock ??= clock;
    // Subtitles come in order; a repeated time replaces the previous sample.
    if (times.length > 0 && time <= (times[times.length - 1] as number)) {
      if (time === times[times.length - 1]) samples[samples.length - 1] = sample;
      continue;
    }
    times.push(time);
    samples.push(sample);
  }
  if (times.length === 0) throw new DjiSrtParseError(`'${name}' has no DJI telemetry subtitles`);

  const time = Float64Array.from(times);
  const values = (field: Field) => Float64Array.from(samples, (s) => s[field] ?? Number.NaN);
  const channels: Channel[] = [];
  for (const field of Object.keys(CHANNELS) as Field[]) {
    if (!samples.some((s) => s[field] !== undefined)) continue;
    channels.push({ ...CHANNELS[field], time, values: values(field) });
  }
  const has = (key: string) => channels.some((c) => c.key === key);
  if (!has(StandardChannel.speed) && has(StandardChannel.latitude) && has(StandardChannel.longitude)) {
    channels.push({
      key: StandardChannel.speed,
      label: 'Speed (from GPS)',
      unit: 'm/s',
      time,
      values: speedFromPositions(time, values('latitude'), values('longitude')),
    });
  }
  if (channels.length === 0) throw new DjiSrtParseError(`'${name}' has no telemetry values DJI writes`);
  const metadata: Record<string, string> = { device: 'DJI' };
  if (firstClock) metadata.clock = firstClock;
  return { kind: 'dji', name, startEpochMs: null, channels, metadata };
}
