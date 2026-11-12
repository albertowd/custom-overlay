import { z } from 'zod';
import { backgroundFields, backgroundProps, drawBackground, maxOf, niceStep } from '../draw.js';
import { formatNumber } from '../format.js';
import { defineWidget, type FieldSpec } from '../types.js';
import { DISTANCE_UNITS, drawBar, drawBarValue } from './bar.js';

export { DISTANCE_UNITS, type DistanceUnit, valueAt } from './bar.js';

/** Settings shared by the distance and lap bars. */
export const barProps = {
  valueId: z.string().default('distance.traveled'),
  unit: z.enum(['km', 'm', 'mi']).default('km'),
  /** Full bar distance in display units; 0 = session total. */
  total: z.number().min(0).default(0),
  minorTicks: z.number().int().min(0).max(9).default(1),
  decimals: z.number().int().min(0).max(3).default(2),
  color: z.string().default('primary'),
  trackColor: z.string().default('textMuted'),
  textColor: z.string().default('text'),
  showLabels: z.boolean().default(true),
  showValue: z.boolean().default(true),
  ...backgroundProps(),
};

export const UNIT_FIELD: FieldSpec = {
  key: 'unit',
  label: 'Unit',
  kind: 'select',
  options: [
    ['km', 'Kilometers'],
    ['m', 'Meters'],
    ['mi', 'Miles'],
  ],
};

export const BAR_STYLE_FIELDS: readonly FieldSpec[] = [
  { key: 'decimals', label: 'Decimals', kind: 'number', min: 0, max: 3 },
  { key: 'color', label: 'Progress', kind: 'color' },
  { key: 'trackColor', label: 'Track', kind: 'color' },
  { key: 'textColor', label: 'Text', kind: 'color' },
  { key: 'showLabels', label: 'Tick labels', kind: 'boolean' },
  { key: 'showValue', label: 'Current distance', kind: 'boolean' },
  ...backgroundFields(),
];

/** Full bar distance in display units: the set total, else the session's, else 1. */
export function barTotal(
  distance: Float64Array | undefined,
  unit: keyof typeof DISTANCE_UNITS,
  total: number,
) {
  const session = maxOf(distance) / DISTANCE_UNITS[unit];
  return total > 0 ? total : Number.isFinite(session) && session > 0 ? session : 1;
}

export const distanceBar = defineWidget({
  type: 'distance-bar',
  name: 'Distance bar',
  description: 'Progress bar of the distance covered, with tick marks every distance step.',
  category: 'data',
  defaultSize: { width: 0.4, height: 0.08 },
  schema: z.object({
    ...barProps,
    /** Major tick step in display units; 0 = automatic. */
    tickStep: z.number().min(0).default(0),
  }),
  fields: [
    { key: 'valueId', label: 'Distance value (m)', kind: 'value' },
    UNIT_FIELD,
    { key: 'total', label: 'Total', kind: 'number', min: 0, hint: 'In the unit above; 0 = session total' },
    { key: 'tickStep', label: 'Tick step', kind: 'number', min: 0, hint: '0 = automatic' },
    {
      key: 'minorTicks',
      label: 'Minor ticks',
      kind: 'number',
      min: 0,
      max: 9,
      hint: 'Between major ticks',
    },
    ...BAR_STYLE_FIELDS,
  ],
  inputs: (props) => [props.valueId],
  prepare: ({ props, values }) => {
    const total = barTotal(values.get(props.valueId), props.unit, props.total);
    return { total, step: props.tickStep > 0 ? props.tickStep : niceStep(total, 5) };
  },
  render(ctx, frame) {
    const { props, prepared } = frame;
    const { total, step } = prepared;
    drawBackground(ctx, frame, props);
    const current = frame.value(props.valueId) / DISTANCE_UNITS[props.unit];
    const bar = drawBar(ctx, frame, props, 0, total, current);

    // Ticks before the end (the total is rarely a multiple of the step), then the end tick.
    const minor = step / (props.minorTicks + 1);
    const labelDecimals = step < 1 ? Math.min(3, Math.ceil(-Math.log10(step))) : 0;
    const labelWidth = step * 0.9 * ((bar.right - bar.left) / total);
    const epsilon = minor * 1e-6;
    for (let i = 0; i * minor < total - epsilon; i++) {
      const isMajor = i % (props.minorTicks + 1) === 0;
      // Skip a label that would overlap the end label.
      const label = isMajor && total - i * minor >= step * 0.75 ? formatNumber(i * minor, labelDecimals) : '';
      bar.tick(i * minor, isMajor, label, labelWidth);
    }
    const onStep = Math.abs(total / step - Math.round(total / step)) < 1e-6;
    const endDecimals = onStep ? labelDecimals : Math.max(labelDecimals, Math.min(props.decimals, 1));
    bar.tick(total, true, formatNumber(total, endDecimals), labelWidth);

    drawBarValue(
      ctx,
      frame,
      props,
      bar,
      `${formatNumber(current, props.decimals)} ${props.unit}`,
      `${formatNumber(total, props.decimals)} ${props.unit}`,
    );
  },
});
