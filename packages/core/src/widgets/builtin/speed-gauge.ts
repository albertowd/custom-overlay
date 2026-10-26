import { z } from 'zod';
import { drawDisc, fitText, maxOf, niceCeil, niceStep } from '../draw.js';
import { formatNumber } from '../format.js';
import { defineWidget } from '../types.js';

const DEG = Math.PI / 180;

export const speedGauge = defineWidget({
  type: 'speed-gauge',
  name: 'Speed gauge',
  description: 'Analog gauge with needle, ticks and a digital readout. Works with any value (RPM, G...).',
  category: 'data',
  defaultSize: { width: 0.16, height: 0.284 },
  aspectRatio: 1,
  schema: z.object({
    valueId: z.string().default('speed.kmh'),
    label: z.string().default('km/h'),
    min: z.number().default(0),
    /** 0 = automatic (session maximum rounded up). */
    max: z.number().min(0).default(0),
    /** 0 = automatic. */
    majorStep: z.number().min(0).default(0),
    minorTicks: z.number().int().min(0).max(10).default(4),
    sweep: z.number().min(90).max(360).default(270),
    decimals: z.number().int().min(0).max(3).default(0),
    color: z.string().default('primary'),
    trackColor: z.string().default('textMuted'),
    /** A drawn line, your own image, or nothing in the middle of the gauge. */
    needle: z.enum(['line', 'image', 'none']).default('line'),
    needleColor: z.string().default('text'),
    /** Needle image (data URL), drawn pointing to the value. */
    needleSrc: z.string().default(''),
    /** Length from the pivot to the tip, % of the gauge radius. */
    needleLength: z.number().min(5).max(150).default(90),
    /** Where the image turns, % of its height from its bottom (needles with a tail: above 0). */
    needlePivot: z.number().min(0).max(100).default(0),
    /** Direction the image points to, in degrees from up (e.g. 90 for an image pointing right). */
    needleAngle: z.number().default(0),
    textColor: z.string().default('text'),
    showDigital: z.boolean().default(true),
    /** Vertical position of the digital readout, % of the radius below the center (negative: above). */
    digitalY: z.number().min(-90).max(90).default(56),
    showLabels: z.boolean().default(true),
    background: z.boolean().default(true),
  }),
  fields: [
    { key: 'valueId', label: 'Value', kind: 'value' },
    { key: 'label', label: 'Unit label', kind: 'text' },
    { key: 'min', label: 'Minimum', kind: 'number' },
    { key: 'max', label: 'Maximum', kind: 'number', min: 0, hint: '0 = session maximum' },
    { key: 'majorStep', label: 'Major tick step', kind: 'number', min: 0, hint: '0 = automatic' },
    { key: 'minorTicks', label: 'Minor ticks', kind: 'number', min: 0, max: 10 },
    { key: 'sweep', label: 'Sweep (degrees)', kind: 'number', min: 90, max: 360, step: 10 },
    { key: 'decimals', label: 'Decimals', kind: 'number', min: 0, max: 3 },
    { key: 'color', label: 'Value arc', kind: 'color' },
    { key: 'trackColor', label: 'Track', kind: 'color' },
    {
      key: 'needle',
      label: 'Needle',
      kind: 'select',
      options: [
        ['line', 'Line'],
        ['image', 'Image'],
        ['none', 'None (nothing in the middle)'],
      ],
    },
    { key: 'needleColor', label: 'Needle color', kind: 'color', hint: 'Line needle' },
    { key: 'needleSrc', label: 'Needle image', kind: 'image', hint: 'Pointing up by default' },
    {
      key: 'needleLength',
      label: 'Needle length',
      kind: 'number',
      min: 5,
      max: 150,
      step: 5,
      hint: '% of the radius, pivot to tip',
    },
    {
      key: 'needlePivot',
      label: 'Image pivot',
      kind: 'number',
      min: 0,
      max: 100,
      step: 1,
      hint: '% of the image height from its bottom',
    },
    {
      key: 'needleAngle',
      label: 'Image points to (°)',
      kind: 'number',
      step: 90,
      hint: '0 = up, 90 = right',
    },
    { key: 'textColor', label: 'Text', kind: 'color' },
    { key: 'showDigital', label: 'Digital readout', kind: 'boolean' },
    {
      key: 'digitalY',
      label: 'Readout position (Y)',
      kind: 'number',
      min: -90,
      max: 90,
      step: 1,
      hint: '% of the radius below the center (negative: above)',
    },
    { key: 'showLabels', label: 'Tick labels', kind: 'boolean' },
    { key: 'background', label: 'Background disc', kind: 'boolean' },
  ],
  inputs: (props) => [props.valueId],
  prepare: ({ props, values }) => {
    const max =
      props.max > props.min ? props.max : niceCeil(Math.max(maxOf(values.get(props.valueId)), props.min + 1));
    return { max: Number.isFinite(max) ? max : props.min + 100 };
  },
  render(ctx, frame) {
    const { props, prepared } = frame;
    const { min } = props;
    const max = Math.max(prepared.max, min + 1);
    const size = Math.min(frame.width, frame.height);
    const cx = frame.width / 2;
    const cy = frame.height / 2;
    const radius = size * 0.46;
    const u = size / 100;
    const start = (90 + (360 - props.sweep) / 2) * DEG;
    const angleOf = (v: number) =>
      start + ((Math.min(Math.max(v, min), max) - min) / (max - min)) * props.sweep * DEG;

    if (props.background) drawDisc(ctx, cx, cy, size * 0.5, frame.palette.background);

    // Track and value arcs
    ctx.lineCap = 'round';
    ctx.lineWidth = u * 4;
    ctx.save();
    ctx.strokeStyle = frame.color(props.trackColor);
    ctx.globalAlpha *= 0.35;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.92, start, start + props.sweep * DEG);
    ctx.stroke();
    ctx.restore();
    const value = frame.value(props.valueId);
    if (Number.isFinite(value) && value > min) {
      ctx.strokeStyle = frame.color(props.color);
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.92, start, angleOf(value));
      ctx.stroke();
    }

    // Ticks
    const major = props.majorStep > 0 ? props.majorStep : niceStep(max - min, 6);
    const minor = major / (props.minorTicks + 1);
    ctx.strokeStyle = frame.color(props.textColor);
    ctx.fillStyle = frame.color(props.textColor);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; min + i * minor <= max + 1e-9; i++) {
      const v = min + i * minor;
      const isMajor = i % (props.minorTicks + 1) === 0;
      const a = angleOf(v);
      const inner = radius * (isMajor ? 0.72 : 0.78);
      ctx.lineWidth = u * (isMajor ? 1.2 : 0.6);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a) * radius * 0.84, cy + Math.sin(a) * radius * 0.84);
      ctx.stroke();
      if (isMajor && props.showLabels) {
        const r = radius * 0.6;
        fitText(
          ctx,
          frame,
          formatNumber(v, major < 1 ? 1 : 0),
          cx + Math.cos(a) * r,
          cy + Math.sin(a) * r,
          u * 14,
          u * 7,
        );
      }
    }

    // Needle: a line with its hub, your image, or nothing.
    const length = radius * (props.needleLength / 100);
    if (props.needle === 'line') {
      if (Number.isFinite(value)) {
        const a = angleOf(value);
        ctx.strokeStyle = frame.color(props.needleColor);
        ctx.lineWidth = u * 1.8;
        ctx.beginPath();
        ctx.moveTo(cx - Math.cos(a) * radius * 0.12, cy - Math.sin(a) * radius * 0.12);
        ctx.lineTo(cx + Math.cos(a) * length, cy + Math.sin(a) * length);
        ctx.stroke();
      }
      drawDisc(ctx, cx, cy, u * 4, frame.color(props.needleColor));
    } else if (props.needle === 'image' && Number.isFinite(value)) {
      const image = props.needleSrc ? frame.image(props.needleSrc) : undefined;
      const dims = image as { width: number; height: number } | undefined;
      if (image && dims && dims.width > 0 && dims.height > 0) {
        // The part above the pivot is the needle length; the image keeps its proportions.
        const pivot = props.needlePivot / 100;
        const height = length / Math.max(1 - pivot, 0.05);
        const width = (dims.width / dims.height) * height;
        ctx.save();
        ctx.translate(cx, cy);
        // Canvas angle 0 points right; the image points up (-90°) unless told otherwise.
        ctx.rotate(angleOf(value) + Math.PI / 2 - props.needleAngle * DEG);
        ctx.drawImage(image, -width / 2, -height * (1 - pivot), width, height);
        ctx.restore();
      }
    }

    // Digital readout
    if (props.showDigital) {
      const y = cy + radius * (props.digitalY / 100);
      ctx.fillStyle = frame.color(props.textColor);
      fitText(ctx, frame, formatNumber(value, props.decimals, '—'), cx, y, radius * 0.9, u * 16, 700);
      ctx.fillStyle = frame.color('textMuted');
      fitText(ctx, frame, props.label, cx, y + radius * 0.26, radius * 0.8, u * 6.5, 500);
    }
  },
});
