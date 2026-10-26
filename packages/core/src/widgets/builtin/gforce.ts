import { z } from 'zod';
import { drawDisc, fitText, withAlpha } from '../draw.js';
import { formatNumber } from '../format.js';
import { defineWidget } from '../types.js';

/** Frame rate of a value series, from its frame times. */
function seriesFrameRate(times: Float64Array): number {
  const n = times.length;
  if (n < 2) return 30;
  return (n - 1) / ((times[n - 1] as number) - (times[0] as number));
}

/**
 * Value read for a configured id. Widgets saved before `accel.*` existed store the raw channel ids;
 * `accel.lateral` / `accel.longitudinal` return those channels when logged, so nothing is lost.
 */
const LEGACY_IDS: Record<string, string> = {
  accelLateral: 'accel.lateral',
  accelLongitudinal: 'accel.longitudinal',
};
const valueId = (id: string) => LEGACY_IDS[id] ?? id;

export const gForce = defineWidget({
  type: 'g-force',
  name: 'G-force',
  description: 'Friction circle: lateral and longitudinal G as a dot with a fading trail.',
  category: 'data',
  defaultSize: { width: 0.14, height: 0.249 },
  aspectRatio: 1,
  schema: z.object({
    lateralId: z.string().default('accel.lateral'),
    longitudinalId: z.string().default('accel.longitudinal'),
    /** G at the outer ring. */
    range: z.number().positive().default(1.5),
    ringStep: z.number().positive().default(0.5),
    trailSeconds: z.number().min(0).max(10).default(1.5),
    /** Positive lateral G is drawn to the right, positive longitudinal G upwards, unless inverted. */
    invertLateral: z.boolean().default(false),
    invertLongitudinal: z.boolean().default(false),
    dotColor: z.string().default('primary'),
    trailColor: z.string().default('secondary'),
    gridColor: z.string().default('textMuted'),
    showValue: z.boolean().default(true),
    valuePosition: z.enum(['bottom', 'top']).default('bottom'),
    showRings: z.boolean().default(true),
    showAxes: z.boolean().default(true),
    background: z.boolean().default(true),
  }),
  fields: [
    { key: 'lateralId', label: 'Lateral G', kind: 'value' },
    { key: 'longitudinalId', label: 'Longitudinal G', kind: 'value' },
    { key: 'range', label: 'Range (G)', kind: 'number', min: 0.1, step: 0.1 },
    { key: 'ringStep', label: 'Ring step (G)', kind: 'number', min: 0.1, step: 0.1 },
    { key: 'trailSeconds', label: 'Trail (s)', kind: 'number', min: 0, max: 10, step: 0.5 },
    { key: 'invertLateral', label: 'Invert lateral', kind: 'boolean' },
    { key: 'invertLongitudinal', label: 'Invert longitudinal', kind: 'boolean' },
    { key: 'dotColor', label: 'Dot', kind: 'color' },
    { key: 'trailColor', label: 'Trail', kind: 'color' },
    { key: 'gridColor', label: 'Grid', kind: 'color' },
    { key: 'showValue', label: 'Combined G readout', kind: 'boolean' },
    {
      key: 'valuePosition',
      label: 'Readout position',
      kind: 'select',
      options: [
        ['bottom', 'Bottom'],
        ['top', 'Top'],
      ],
    },
    { key: 'showRings', label: 'Rings', kind: 'boolean', hint: 'The circles at each ring step' },
    { key: 'showAxes', label: 'Cross lines', kind: 'boolean', hint: 'The lateral and longitudinal axes' },
    { key: 'background', label: 'Background disc', kind: 'boolean' },
  ],
  inputs: (props) => [valueId(props.lateralId), valueId(props.longitudinalId)],
  prepare: ({ props, values }) => ({
    lateral: values.get(valueId(props.lateralId)),
    longitudinal: values.get(valueId(props.longitudinalId)),
    frameRate: seriesFrameRate(values.times),
  }),
  render(ctx, frame) {
    const { props, prepared } = frame;
    const size = Math.min(frame.width, frame.height);
    const u = size / 100;
    const cx = frame.width / 2;
    const cy = frame.height / 2;
    const radius = size * 0.44;
    const sx = props.invertLateral ? -1 : 1;
    const sy = props.invertLongitudinal ? 1 : -1;
    const point = (lat: number, lon: number): [number, number] => {
      // Clamp to the outer ring so extreme values stay visible.
      const g = Math.hypot(lat, lon);
      const k = g > props.range ? props.range / g : 1;
      return [cx + ((sx * lat * k) / props.range) * radius, cy + ((sy * lon * k) / props.range) * radius];
    };

    if (props.background) drawDisc(ctx, cx, cy, size * 0.5, frame.palette.background);

    // Rings and axes
    const grid = frame.color(props.gridColor);
    ctx.strokeStyle = withAlpha(grid, 0.45);
    ctx.lineWidth = u * 0.6;
    const valueOnTop = props.valuePosition === 'top';
    if (props.showRings) {
      for (let g = props.ringStep; g <= props.range + 1e-9; g += props.ringStep) {
        ctx.beginPath();
        ctx.arc(cx, cy, (g / props.range) * radius, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (props.showAxes) {
      ctx.beginPath();
      ctx.moveTo(cx - radius, cy);
      ctx.lineTo(cx + radius, cy);
      ctx.moveTo(cx, cy - radius);
      ctx.lineTo(cx, cy + radius);
      ctx.stroke();
    }
    if (props.showRings) {
      // Outer ring label, on the side opposite to the readout.
      ctx.fillStyle = withAlpha(grid, 0.8);
      ctx.textAlign = 'left';
      ctx.textBaseline = valueOnTop ? 'top' : 'bottom';
      const labelY = valueOnTop ? cy + radius - u * 7 : cy - radius + u * 7;
      fitText(ctx, frame, `${props.range}g`, cx + u * 1.5, labelY, radius, u * 5, 500);
    }

    // Trail
    const { lateral, longitudinal } = prepared;
    const trailFrames = Math.round(props.trailSeconds * prepared.frameRate);
    if (lateral && longitudinal && frame.frameIndex > 0 && trailFrames > 1) {
      const trail = frame.color(props.trailColor);
      ctx.lineWidth = u * 1.4;
      ctx.lineCap = 'round';
      const first = Math.max(0, frame.frameIndex - trailFrames);
      for (let i = first + 1; i <= frame.frameIndex; i++) {
        const a = point(lateral[i - 1] as number, longitudinal[i - 1] as number);
        const b = point(lateral[i] as number, longitudinal[i] as number);
        if (![...a, ...b].every(Number.isFinite)) continue;
        ctx.strokeStyle = withAlpha(trail, (i - first) / (frame.frameIndex - first + 1));
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }
    }

    // Current value
    const lat = frame.value(valueId(props.lateralId));
    const lon = frame.value(valueId(props.longitudinalId));
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const [x, y] = point(lat, lon);
      drawDisc(ctx, x, y, u * 4.5, frame.color(props.dotColor));
    }
    if (props.showValue) {
      ctx.fillStyle = frame.color('text');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      fitText(
        ctx,
        frame,
        `${formatNumber(Math.hypot(lat, lon), 2)} g`,
        cx,
        cy + radius * (valueOnTop ? -0.78 : 0.78),
        radius,
        u * 8,
        700,
      );
    }
  },
});
