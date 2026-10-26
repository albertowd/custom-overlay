import { z } from 'zod';
import { drawMarker, drawPanel, withAlpha } from '../draw.js';
import { defineWidget, type FieldSpec, type ValueSeries } from '../types.js';

const EARTH_RADIUS = 6_371_000;
const MAX_PATH_POINTS = 3000;

export interface ProjectedPath {
  /** Local coordinates in meters (x east, y south), NaN without fix; one per frame. */
  xs: Float64Array;
  ys: Float64Array;
  bounds: { minX: number; maxX: number; minY: number; maxY: number } | null;
  /** Frame step used to draw the full path. */
  step: number;
}

/** Project GPS positions to local meters around their center (equirectangular). */
export function projectPath(
  latitudes: Float64Array | undefined,
  longitudes: Float64Array | undefined,
): ProjectedPath {
  const n = Math.min(latitudes?.length ?? 0, longitudes?.length ?? 0);
  const xs = new Float64Array(n).fill(Number.NaN);
  const ys = new Float64Array(n).fill(Number.NaN);
  if (!latitudes || !longitudes || n === 0) return { xs, ys, bounds: null, step: 1 };
  let latSum = 0;
  let lonSum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const lat = latitudes[i] as number;
    const lon = longitudes[i] as number;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    latSum += lat;
    lonSum += lon;
    count++;
  }
  if (count === 0) return { xs, ys, bounds: null, step: 1 };
  const lat0 = latSum / count;
  const lon0 = lonSum / count;
  const k = (Math.PI / 180) * EARTH_RADIUS;
  const cos0 = Math.cos(lat0 * (Math.PI / 180));
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (let i = 0; i < n; i++) {
    const lat = latitudes[i] as number;
    const lon = longitudes[i] as number;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    const x = (lon - lon0) * k * cos0;
    const y = -(lat - lat0) * k;
    xs[i] = x;
    ys[i] = y;
    bounds.minX = Math.min(bounds.minX, x);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxY = Math.max(bounds.maxY, y);
  }
  return { xs, ys, bounds, step: Math.max(1, Math.ceil(n / MAX_PATH_POINTS)) };
}

const DEG = Math.PI / 180;
/** Positions closer than this (meters) do not change the computed heading. */
const MIN_HEADING_DISTANCE = 1;

/**
 * Heading per frame in degrees clockwise from north: from a heading value when available,
 * otherwise from the direction of travel around each frame (±0.5 s).
 */
export function headings(
  xs: Float64Array,
  ys: Float64Array,
  heading: Float64Array | undefined,
  frameRate: number,
): Float64Array {
  const n = xs.length;
  const out = new Float64Array(n).fill(Number.NaN);
  const k = Math.max(1, Math.round(frameRate * 0.5));
  let last = Number.NaN;
  for (let i = 0; i < n; i++) {
    const logged = heading?.[i];
    if (logged !== undefined && Number.isFinite(logged)) {
      out[i] = logged;
      last = logged;
      continue;
    }
    const a = Math.max(0, i - k);
    const b = Math.min(n - 1, i + k);
    const dx = (xs[b] as number) - (xs[a] as number);
    const dy = (ys[b] as number) - (ys[a] as number);
    if (Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) >= MIN_HEADING_DISTANCE) {
      // x east, y south: north is -y.
      last = (Math.atan2(dx, -dy) / DEG + 360) % 360;
    }
    out[i] = last;
  }
  return out;
}

export interface TrackPath extends ProjectedPath {
  /** Heading per frame, degrees clockwise from north. */
  headings: Float64Array;
}

/** Projected path and headings of the session, for the map widgets. */
export function prepareTrack(
  values: ValueSeries,
  latitudeId: string,
  longitudeId: string,
  headingId: string,
): TrackPath {
  const path = projectPath(values.get(latitudeId), values.get(longitudeId));
  const times = values.times;
  const frameRate =
    times.length > 1 ? (times.length - 1) / ((times[times.length - 1] as number) - (times[0] as number)) : 30;
  return { ...path, headings: headings(path.xs, path.ys, values.get(headingId), frameRate) };
}

/** Index of the last known position at or before a frame, -1 when none. */
export function lastPositionIndex(track: ProjectedPath, frameIndex: number): number {
  let index = Math.min(frameIndex, track.xs.length - 1);
  while (index >= 0 && Number.isNaN(track.xs[index] as number)) index--;
  return index;
}

/** Marker props shared by the map widgets. */
export const markerProps = {
  markerSrc: z.string().default(''),
  /** Marker size, % of the smaller side. */
  markerSize: z.number().min(2).max(60).default(14),
  /** Direction the marker image points to, in degrees from up (e.g. 90 for an image facing right). */
  markerAngle: z.number().default(0),
  markerColor: z.string().default('primary'),
};

export const markerFields: FieldSpec[] = [
  { key: 'markerSrc', label: 'Marker image', kind: 'image', hint: 'A car, a kart… rotated with the heading' },
  { key: 'markerSize', label: 'Marker size', kind: 'number', min: 2, max: 60, hint: '% of the smaller side' },
  {
    key: 'markerAngle',
    label: 'Marker image faces (°)',
    kind: 'number',
    step: 90,
    hint: '0 = up, 90 = right',
  },
  { key: 'markerColor', label: 'Marker', kind: 'color' },
];

/** Outline drawn under the path lines so they read on the video without a background. */
export const strokeProps = {
  stroke: z.boolean().default(false),
  strokeColor: z.string().default('background'),
  /** Outline width on each side of the line, % of the smaller side. */
  strokeWidth: z.number().min(0.1).max(10).default(1),
};

export const strokeFields: FieldSpec[] = [
  {
    key: 'stroke',
    label: 'Path outline',
    kind: 'boolean',
    hint: 'Keeps the path readable without a background',
  },
  { key: 'strokeColor', label: 'Outline', kind: 'color' },
  {
    key: 'strokeWidth',
    label: 'Outline width',
    kind: 'number',
    min: 0.1,
    max: 10,
    step: 0.1,
    hint: '% of the smaller side',
  },
];

export const gpsPath = defineWidget({
  type: 'gps-path',
  name: 'GPS path',
  description:
    'Map of the whole session path (north up) with the progress so far and the current position (a dot or your image).',
  category: 'map',
  defaultSize: { width: 0.18, height: 0.32 },
  schema: z.object({
    latitudeId: z.string().default('latitude'),
    longitudeId: z.string().default('longitude'),
    /** Degrees from north; computed from the path when the value is missing. */
    headingId: z.string().default('heading'),
    lineWidth: z.number().min(0.2).max(10).default(1.5),
    pathColor: z.string().default('textMuted'),
    progressColor: z.string().default('primary'),
    ...strokeProps,
    ...markerProps,
    markerSize: z.number().min(2).max(60).default(8),
    showProgress: z.boolean().default(true),
    background: z.boolean().default(true),
  }),
  fields: [
    { key: 'latitudeId', label: 'Latitude', kind: 'value' },
    { key: 'longitudeId', label: 'Longitude', kind: 'value' },
    {
      key: 'headingId',
      label: 'Heading',
      kind: 'value',
      hint: 'Turns the marker image; computed when missing',
    },
    {
      key: 'lineWidth',
      label: 'Line width',
      kind: 'number',
      min: 0.2,
      max: 10,
      step: 0.1,
      hint: '% of the smaller side',
    },
    { key: 'pathColor', label: 'Path', kind: 'color' },
    { key: 'progressColor', label: 'Progress', kind: 'color' },
    ...strokeFields,
    ...markerFields,
    { key: 'showProgress', label: 'Highlight progress', kind: 'boolean' },
    { key: 'background', label: 'Background panel', kind: 'boolean' },
  ],
  inputs: (props) => [props.latitudeId, props.longitudeId, props.headingId],
  prepare: ({ props, values }) => prepareTrack(values, props.latitudeId, props.longitudeId, props.headingId),
  render(ctx, frame) {
    const { props, prepared } = frame;
    if (props.background) drawPanel(ctx, frame);
    const { xs, ys, bounds, step } = prepared;
    if (!bounds) return;
    const pad = Math.min(frame.width, frame.height) * 0.1;
    const spanX = Math.max(bounds.maxX - bounds.minX, 1);
    const spanY = Math.max(bounds.maxY - bounds.minY, 1);
    const scale = Math.min((frame.width - pad * 2) / spanX, (frame.height - pad * 2) / spanY);
    const offsetX = (frame.width - spanX * scale) / 2 - bounds.minX * scale;
    const offsetY = (frame.height - spanY * scale) / 2 - bounds.minY * scale;

    const trace = (from: number, to: number) => {
      ctx.beginPath();
      let pen = false;
      for (let i = from; i <= to; i += step) {
        const x = xs[i] as number;
        const y = ys[i] as number;
        if (Number.isNaN(x)) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(x * scale + offsetX, y * scale + offsetY);
        else ctx.moveTo(x * scale + offsetX, y * scale + offsetY);
        pen = true;
      }
      ctx.stroke();
    };

    const index = lastPositionIndex(prepared, frame.frameIndex);
    const progressWidth = props.lineWidth * 1.3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (props.stroke) {
      ctx.strokeStyle = frame.color(props.strokeColor);
      ctx.lineWidth = frame.unit * (props.lineWidth + props.strokeWidth * 2);
      trace(0, xs.length - 1);
      if (props.showProgress && index >= 0) {
        ctx.lineWidth = frame.unit * (progressWidth + props.strokeWidth * 2);
        trace(0, index);
      }
    }
    ctx.lineWidth = frame.unit * props.lineWidth;
    ctx.strokeStyle = withAlpha(frame.color(props.pathColor), 0.7);
    trace(0, xs.length - 1);

    if (index < 0) return;
    if (props.showProgress) {
      ctx.strokeStyle = frame.color(props.progressColor);
      ctx.lineWidth = frame.unit * progressWidth;
      trace(0, index);
    }
    const heading = prepared.headings[index] as number;
    drawMarker(
      ctx,
      frame,
      (xs[index] as number) * scale + offsetX,
      (ys[index] as number) * scale + offsetY,
      Number.isFinite(heading) ? heading * DEG : 0,
      {
        src: props.markerSrc,
        size: frame.unit * props.markerSize,
        angle: props.markerAngle,
        color: frame.color(props.markerColor),
        shape: 'dot',
      },
    );
  },
});
