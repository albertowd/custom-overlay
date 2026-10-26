import { z } from 'zod';
import { drawDisc, drawPanel, fitText, maxOf, minOf, withAlpha } from '../draw.js';
import { formatNumber } from '../format.js';
import { defineWidget } from '../types.js';

const FEET = 3.28084;
const PROFILE_POINTS = 300;

export const elevation = defineWidget({
  type: 'elevation',
  name: 'Elevation',
  description: 'Current altitude with the elevation profile of the whole session.',
  category: 'data',
  defaultSize: { width: 0.2, height: 0.12 },
  schema: z.object({
    valueId: z.string().default('altitude'),
    unit: z.enum(['m', 'ft']).default('m'),
    label: z.string().default('ELEV'),
    decimals: z.number().int().min(0).max(2).default(0),
    showProfile: z.boolean().default(true),
    color: z.string().default('secondary'),
    markerColor: z.string().default('primary'),
    textColor: z.string().default('text'),
    background: z.boolean().default(true),
  }),
  fields: [
    { key: 'valueId', label: 'Altitude value (m)', kind: 'value' },
    {
      key: 'unit',
      label: 'Unit',
      kind: 'select',
      options: [
        ['m', 'Meters'],
        ['ft', 'Feet'],
      ],
    },
    { key: 'label', label: 'Label', kind: 'text' },
    { key: 'decimals', label: 'Decimals', kind: 'number', min: 0, max: 2 },
    { key: 'showProfile', label: 'Profile', kind: 'boolean' },
    { key: 'color', label: 'Profile color', kind: 'color' },
    { key: 'markerColor', label: 'Marker', kind: 'color' },
    { key: 'textColor', label: 'Text', kind: 'color' },
    { key: 'background', label: 'Background panel', kind: 'boolean' },
  ],
  inputs: (props) => [props.valueId],
  prepare: ({ props, values }) => {
    const altitude = values.get(props.valueId);
    if (!altitude || altitude.length === 0)
      return { profile: [] as [number, number][], min: 0, max: 1, frames: 0 };
    // Down-sample to a few hundred points (max per bucket keeps the peaks).
    const bucket = Math.max(1, Math.ceil(altitude.length / PROFILE_POINTS));
    const profile: [number, number][] = [];
    for (let i = 0; i < altitude.length; i += bucket) {
      const peak = maxOf(altitude.subarray(i, i + bucket));
      if (Number.isFinite(peak)) profile.push([i / Math.max(1, altitude.length - 1), peak]);
    }
    const min = minOf(altitude);
    const max = maxOf(altitude);
    return { profile, min, max: max > min ? max : min + 1, frames: altitude.length };
  },
  render(ctx, frame) {
    const { props, prepared } = frame;
    if (props.background) drawPanel(ctx, frame);
    const scale = props.unit === 'ft' ? FEET : 1;
    const pad = Math.min(frame.width, frame.height) * 0.1;
    const textHeight = props.showProfile ? frame.height * 0.42 : frame.height;
    const value = frame.value(props.valueId) * scale;

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = frame.color('textMuted');
    fitText(ctx, frame, props.label, pad, textHeight / 2, frame.width * 0.3, textHeight * 0.38, 600);
    ctx.textAlign = 'right';
    ctx.fillStyle = frame.color(props.textColor);
    fitText(
      ctx,
      frame,
      `${formatNumber(value, props.decimals)} ${props.unit}`,
      frame.width - pad,
      textHeight / 2,
      frame.width * 0.6,
      textHeight * 0.6,
      700,
    );

    if (!props.showProfile || prepared.profile.length < 2) return;
    const top = textHeight;
    const bottom = frame.height - pad * 0.8;
    const left = pad;
    const right = frame.width - pad;
    const x = (f: number) => left + f * (right - left);
    const y = (v: number) => bottom - ((v - prepared.min) / (prepared.max - prepared.min)) * (bottom - top);
    const color = frame.color(props.color);

    ctx.beginPath();
    ctx.moveTo(x(prepared.profile[0]?.[0] ?? 0), bottom);
    for (const [f, v] of prepared.profile) ctx.lineTo(x(f), y(v));
    ctx.lineTo(x(prepared.profile[prepared.profile.length - 1]?.[0] ?? 1), bottom);
    ctx.closePath();
    ctx.fillStyle = withAlpha(color, 0.35);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, frame.unit * 1.2);
    ctx.beginPath();
    for (const [i, [f, v]] of prepared.profile.entries()) {
      if (i === 0) ctx.moveTo(x(f), y(v));
      else ctx.lineTo(x(f), y(v));
    }
    ctx.stroke();

    if (frame.frameIndex >= 0 && prepared.frames > 1 && Number.isFinite(value)) {
      const f = frame.frameIndex / (prepared.frames - 1);
      ctx.strokeStyle = withAlpha(frame.color(props.markerColor), 0.6);
      ctx.beginPath();
      ctx.moveTo(x(f), top);
      ctx.lineTo(x(f), bottom);
      ctx.stroke();
      drawDisc(ctx, x(f), y(value / scale), frame.unit * 3, frame.color(props.markerColor));
    }
  },
});
