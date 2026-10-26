import { z } from 'zod';
import { drawDisc, drawMarker, roundRectPath, withAlpha } from '../draw.js';
import { defineWidget } from '../types.js';
import {
  lastPositionIndex,
  markerFields,
  markerProps,
  prepareTrack,
  strokeFields,
  strokeProps,
} from './gps-path.js';

const DEG = Math.PI / 180;

export const liveMap = defineWidget({
  type: 'live-map',
  name: 'Live map',
  description:
    'Map following the current position (or showing the whole track), north-up or heading-up, with a marker (or your image) rotated by the heading.',
  category: 'map',
  defaultSize: { width: 0.16, height: 0.284 },
  aspectRatio: 1,
  schema: z.object({
    latitudeId: z.string().default('latitude'),
    longitudeId: z.string().default('longitude'),
    /** Degrees from north; computed from the path when the value is missing. */
    headingId: z.string().default('heading'),
    view: z.enum(['follow', 'whole']).default('follow'),
    /** Meters from the center to the edge (follow view). */
    radius: z.number().positive().default(150),
    orientation: z.enum(['north-up', 'heading-up']).default('heading-up'),
    shape: z.enum(['circle', 'rounded']).default('circle'),
    ...markerProps,
    lineWidth: z.number().min(0.2).max(10).default(2.5),
    pathColor: z.string().default('textMuted'),
    traveledColor: z.string().default('primary'),
    ...strokeProps,
    showNorth: z.boolean().default(true),
    background: z.boolean().default(true),
  }),
  fields: [
    { key: 'latitudeId', label: 'Latitude', kind: 'value' },
    { key: 'longitudeId', label: 'Longitude', kind: 'value' },
    { key: 'headingId', label: 'Heading', kind: 'value', hint: 'Computed from the path when missing' },
    {
      key: 'view',
      label: 'View',
      kind: 'select',
      options: [
        ['follow', 'Follow the position'],
        ['whole', 'Whole track'],
      ],
    },
    { key: 'radius', label: 'Radius (m)', kind: 'number', min: 10, step: 10, hint: 'Follow view' },
    {
      key: 'orientation',
      label: 'Orientation',
      kind: 'select',
      options: [
        ['heading-up', 'Heading up (map rotates)'],
        ['north-up', 'North up (marker rotates)'],
      ],
      hint: 'The whole track is always north up',
    },
    {
      key: 'shape',
      label: 'Shape',
      kind: 'select',
      options: [
        ['circle', 'Circle'],
        ['rounded', 'Rounded rectangle'],
      ],
    },
    ...markerFields,
    { key: 'lineWidth', label: 'Line width', kind: 'number', min: 0.2, max: 10, step: 0.1 },
    { key: 'pathColor', label: 'Path', kind: 'color' },
    { key: 'traveledColor', label: 'Traveled', kind: 'color' },
    ...strokeFields,
    { key: 'showNorth', label: 'North indicator', kind: 'boolean' },
    { key: 'background', label: 'Background', kind: 'boolean' },
  ],
  inputs: (props) => [props.latitudeId, props.longitudeId, props.headingId],
  prepare: ({ props, values }) => prepareTrack(values, props.latitudeId, props.longitudeId, props.headingId),
  render(ctx, frame) {
    const { props, prepared } = frame;
    const size = Math.min(frame.width, frame.height);
    const cx = frame.width / 2;
    const cy = frame.height / 2;
    const u = size / 100;

    ctx.save();
    if (props.shape === 'circle') {
      ctx.beginPath();
      ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
    } else {
      roundRectPath(ctx, 0, 0, frame.width, frame.height, u * 8);
    }
    if (props.background) {
      ctx.fillStyle = frame.palette.background;
      ctx.fill();
    }
    ctx.clip();

    const { xs, ys, step, bounds } = prepared;
    const index = lastPositionIndex(prepared, frame.frameIndex);
    const heading = index >= 0 ? (prepared.headings[index] as number) : Number.NaN;
    const whole = props.view === 'whole' && bounds !== null;
    const headingUp = props.orientation === 'heading-up' && !whole && Number.isFinite(heading);
    const mapRotation = headingUp ? -heading * DEG : 0;

    // Map point at the center and pixels per meter.
    let focusX = xs[index] as number;
    let focusY = ys[index] as number;
    let scale = (size / 2) * (0.92 / props.radius);
    if (whole) {
      const spanX = Math.max(bounds.maxX - bounds.minX, 1);
      const spanY = Math.max(bounds.maxY - bounds.minY, 1);
      focusX = (bounds.minX + bounds.maxX) / 2;
      focusY = (bounds.minY + bounds.maxY) / 2;
      // A circle must hold the corners of the track box.
      scale =
        props.shape === 'circle'
          ? (size * 0.84) / Math.hypot(spanX, spanY)
          : Math.min((frame.width * 0.84) / spanX, (frame.height * 0.84) / spanY);
    }

    if (index >= 0 || whole) {
      const trace = (from: number, to: number) => {
        ctx.beginPath();
        let pen = false;
        for (let i = from; i <= to; i += step) {
          const x = xs[i] as number;
          if (Number.isNaN(x)) {
            pen = false;
            continue;
          }
          const y = ys[i] as number;
          if (pen) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
          pen = true;
        }
        // The step may skip the last points: end exactly at `to`.
        const endX = xs[to] as number;
        if (pen && Number.isFinite(endX)) ctx.lineTo(endX, ys[to] as number);
        ctx.stroke();
      };
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(mapRotation);
      ctx.scale(scale, scale);
      ctx.translate(-focusX, -focusY);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (props.stroke) {
        ctx.lineWidth = (u * (props.lineWidth + props.strokeWidth * 2)) / scale;
        ctx.strokeStyle = frame.color(props.strokeColor);
        trace(0, xs.length - 1);
      }
      ctx.lineWidth = (u * props.lineWidth) / scale;
      ctx.strokeStyle = withAlpha(frame.color(props.pathColor), 0.6);
      trace(0, xs.length - 1);
      if (index >= 0) {
        ctx.strokeStyle = frame.color(props.traveledColor);
        trace(0, index);
      }
      ctx.restore();
    }

    // Marker at the position, pointing to the heading.
    if (index >= 0 || (props.markerSrc && !whole)) {
      const markerX = whole ? cx + ((xs[index] as number) - focusX) * scale : cx;
      const markerY = whole ? cy + ((ys[index] as number) - focusY) * scale : cy;
      drawMarker(ctx, frame, markerX, markerY, !headingUp && Number.isFinite(heading) ? heading * DEG : 0, {
        src: props.markerSrc,
        size: u * props.markerSize,
        angle: props.markerAngle,
        color: frame.color(props.markerColor),
        shape: 'arrow',
      });
    }

    if (props.showNorth) {
      const r = size / 2 - u * 8;
      const angle = mapRotation - Math.PI / 2;
      const nx = cx + Math.cos(angle) * r;
      const ny = cy + Math.sin(angle) * r;
      drawDisc(ctx, nx, ny, u * 5, frame.palette.background);
      ctx.fillStyle = frame.color('text');
      ctx.font = frame.font(u * 6, 700);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('N', nx, ny);
    }
    ctx.restore();
  },
});
