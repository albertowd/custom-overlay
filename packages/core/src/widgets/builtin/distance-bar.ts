import { z } from 'zod';
import { drawPanel, fitText, maxOf, niceStep, roundRectPath, withAlpha } from '../draw.js';
import { formatNumber } from '../format.js';
import { lapsFromSeries } from '../laps.js';
import { defineWidget } from '../types.js';

/** Meters per display unit. */
export const DISTANCE_UNITS = { km: 1000, m: 1, mi: 1609.344 } as const;

/** Value at a timeline time, interpolated between the frames around it. */
function valueAt(times: Float64Array, values: Float64Array, time: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0) return Number.NaN;
  if (time <= (times[0] as number)) return values[0] as number;
  if (time >= (times[hi] as number)) return values[hi] as number;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] as number) <= time) lo = mid;
    else hi = mid;
  }
  const t0 = times[lo] as number;
  const v0 = values[lo] as number;
  const v1 = values[hi] as number;
  return v0 + ((v1 - v0) * (time - t0)) / ((times[hi] as number) - t0);
}

/** Where a lap starts on the bar. */
interface LapMark {
  number: number;
  distance: number;
}

export const distanceBar = defineWidget({
  type: 'distance-bar',
  name: 'Distance bar',
  description:
    'Progress bar of the distance covered, with tick marks every distance step or at each lap start.',
  category: 'data',
  defaultSize: { width: 0.4, height: 0.08 },
  schema: z.object({
    valueId: z.string().default('distance.traveled'),
    unit: z.enum(['km', 'm', 'mi']).default('km'),
    /** Full bar distance in display units; 0 = session total. */
    total: z.number().min(0).default(0),
    /** Major ticks every `tickStep`, or where each lap starts. */
    ticks: z.enum(['distance', 'laps']).default('distance'),
    /** Major tick step in display units; 0 = automatic. */
    tickStep: z.number().min(0).default(0),
    lapTimeId: z.string().default('lap.time'),
    lapNumberId: z.string().default('lap.number'),
    minorTicks: z.number().int().min(0).max(9).default(1),
    decimals: z.number().int().min(0).max(3).default(2),
    color: z.string().default('primary'),
    trackColor: z.string().default('textMuted'),
    textColor: z.string().default('text'),
    showLabels: z.boolean().default(true),
    showValue: z.boolean().default(true),
    background: z.boolean().default(true),
  }),
  fields: [
    { key: 'valueId', label: 'Distance value (m)', kind: 'value' },
    {
      key: 'unit',
      label: 'Unit',
      kind: 'select',
      options: [
        ['km', 'Kilometers'],
        ['m', 'Meters'],
        ['mi', 'Miles'],
      ],
    },
    { key: 'total', label: 'Total', kind: 'number', min: 0, hint: 'In the unit above; 0 = session total' },
    {
      key: 'ticks',
      label: 'Major ticks',
      kind: 'select',
      options: [
        ['distance', 'Every tick step'],
        ['laps', 'At each lap start'],
      ],
    },
    {
      key: 'tickStep',
      label: 'Tick step',
      kind: 'number',
      min: 0,
      hint: '0 = automatic; distance ticks only',
    },
    { key: 'lapTimeId', label: 'Lap time value (s)', kind: 'value', hint: 'Lap ticks only' },
    { key: 'lapNumberId', label: 'Lap number value', kind: 'value', hint: 'Lap ticks only' },
    {
      key: 'minorTicks',
      label: 'Minor ticks',
      kind: 'number',
      min: 0,
      max: 9,
      hint: 'Between major ticks (per lap with lap ticks)',
    },
    { key: 'decimals', label: 'Decimals', kind: 'number', min: 0, max: 3 },
    { key: 'color', label: 'Progress', kind: 'color' },
    { key: 'trackColor', label: 'Track', kind: 'color' },
    { key: 'textColor', label: 'Text', kind: 'color' },
    { key: 'showLabels', label: 'Tick labels', kind: 'boolean' },
    { key: 'showValue', label: 'Current distance', kind: 'boolean' },
    { key: 'background', label: 'Background panel', kind: 'boolean' },
  ],
  inputs: (props) => [props.valueId, ...(props.ticks === 'laps' ? [props.lapTimeId, props.lapNumberId] : [])],
  prepare: ({ props, values }) => {
    const factor = DISTANCE_UNITS[props.unit];
    const distance = values.get(props.valueId);
    const sessionTotal = maxOf(distance) / factor;
    const total =
      props.total > 0 ? props.total : Number.isFinite(sessionTotal) && sessionTotal > 0 ? sessionTotal : 1;
    const laps: LapMark[] = [];
    if (props.ticks === 'laps' && distance) {
      for (const lap of lapsFromSeries(values, props.lapTimeId, props.lapNumberId)) {
        const at = valueAt(values.times, distance, lap.start) / factor;
        if (Number.isFinite(at) && at >= 0 && at < total) laps.push({ number: lap.number, distance: at });
      }
    }
    return { total, step: props.tickStep > 0 ? props.tickStep : niceStep(total, 5), laps };
  },
  render(ctx, frame) {
    const { props, prepared } = frame;
    const { total, step, laps } = prepared;
    if (props.background) drawPanel(ctx, frame);
    const h = frame.height;
    const pad = Math.min(frame.width * 0.04, h * 0.3);
    const left = pad;
    const right = frame.width - pad;
    const barY = h * (props.showValue ? 0.42 : 0.3);
    const barH = h * 0.14;
    const x = (d: number) => left + (Math.min(Math.max(d, 0), total) / total) * (right - left);
    const text = frame.color(props.textColor);

    roundRectPath(ctx, left, barY, right - left, barH, barH / 2);
    ctx.fillStyle = withAlpha(frame.color(props.trackColor), 0.35);
    ctx.fill();
    const current = frame.value(props.valueId) / DISTANCE_UNITS[props.unit];
    if (Number.isFinite(current) && current > 0) {
      roundRectPath(ctx, left, barY, x(current) - left, barH, barH / 2);
      ctx.fillStyle = frame.color(props.color);
      ctx.fill();
    }

    // Ticks and labels
    ctx.strokeStyle = text;
    ctx.fillStyle = text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const minor = step / (props.minorTicks + 1);
    const labelDecimals = step < 1 ? Math.min(3, Math.ceil(-Math.log10(step))) : 0;
    const labelWidth = step * 0.9 * ((right - left) / total);
    const tick = (d: number, isMajor: boolean, label: string, width = labelWidth) => {
      const tx = x(d);
      ctx.lineWidth = Math.max(1, h * (isMajor ? 0.02 : 0.012));
      ctx.beginPath();
      ctx.moveTo(tx, barY + barH);
      ctx.lineTo(tx, barY + barH + h * (isMajor ? 0.12 : 0.07));
      ctx.stroke();
      if (label && props.showLabels)
        fitText(ctx, frame, label, tx, barY + barH + h * 0.15, width, h * 0.2, 500);
    };
    if (props.ticks === 'laps') {
      // A major tick labelled with the lap number where each lap starts, minor ticks splitting
      // each lap. Labels too close to the previous one (many short laps) or to the end are skipped.
      const width = h * 0.9;
      let lastLabel = Number.NEGATIVE_INFINITY;
      laps.forEach((lap, k) => {
        const next = laps[k + 1]?.distance ?? total;
        for (let j = 1; j <= props.minorTicks; j++) {
          tick(lap.distance + ((next - lap.distance) * j) / (props.minorTicks + 1), false, '');
        }
        const tx = x(lap.distance);
        const fits = tx - lastLabel >= width && x(total) - tx >= width * 0.75;
        if (fits) lastLabel = tx;
        tick(lap.distance, true, fits ? formatNumber(lap.number, 0) : '', width);
      });
      tick(total, true, formatNumber(total, Math.min(props.decimals, 1)), width);
    } else {
      // Ticks before the end (the total is rarely a multiple of the step), then the end tick.
      const epsilon = minor * 1e-6;
      for (let i = 0; i * minor < total - epsilon; i++) {
        const isMajor = i % (props.minorTicks + 1) === 0;
        // Skip a label that would overlap the end label.
        const label =
          isMajor && total - i * minor >= step * 0.75 ? formatNumber(i * minor, labelDecimals) : '';
        tick(i * minor, isMajor, label);
      }
      const onStep = Math.abs(total / step - Math.round(total / step)) < 1e-6;
      const endDecimals = onStep ? labelDecimals : Math.max(labelDecimals, Math.min(props.decimals, 1));
      tick(total, true, formatNumber(total, endDecimals));
    }

    if (props.showValue) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      fitText(
        ctx,
        frame,
        `${formatNumber(current, props.decimals)} ${props.unit}`,
        left,
        barY / 2,
        right - left,
        h * 0.28,
        700,
      );
      ctx.textAlign = 'right';
      ctx.fillStyle = frame.color('textMuted');
      fitText(
        ctx,
        frame,
        `${formatNumber(total, props.decimals)} ${props.unit}`,
        right,
        barY / 2,
        (right - left) / 2,
        h * 0.2,
        500,
      );
    }
  },
});
