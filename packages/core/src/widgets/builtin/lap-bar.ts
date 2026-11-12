import { z } from 'zod';
import { drawBackground } from '../draw.js';
import { formatNumber } from '../format.js';
import { type Lap, lapIndexAt, lapsFromSeries } from '../laps.js';
import { defineWidget } from '../types.js';
import { DISTANCE_UNITS, drawBar, drawBarValue, valueAt } from './bar.js';
import { BAR_STYLE_FIELDS, barProps, barTotal, UNIT_FIELD } from './distance-bar.js';

/** A lap with the distance it starts at, in display units. */
interface LapMark extends Lap {
  distance: number;
}

export const lapBar = defineWidget({
  type: 'lap-bar',
  name: 'Lap bar',
  description:
    'Progress bar of the laps: the whole session with a tick at each lap start labelled with its number, or the current lap only.',
  category: 'data',
  defaultSize: { width: 0.4, height: 0.08 },
  schema: z.object({
    ...barProps,
    /** The whole session with lap ticks, or the current lap from its start to its end. */
    view: z.enum(['session', 'lap']).default('session'),
    lapTimeId: z.string().default('lap.time'),
    lapNumberId: z.string().default('lap.number'),
    /** Text before the lap number in the current lap view. */
    label: z.string().default('Lap'),
  }),
  fields: [
    {
      key: 'view',
      label: 'Show',
      kind: 'select',
      options: [
        ['session', 'Whole session, a tick per lap'],
        ['lap', 'Current lap only'],
      ],
    },
    { key: 'valueId', label: 'Distance value (m)', kind: 'value' },
    { key: 'lapTimeId', label: 'Lap time value (s)', kind: 'value' },
    { key: 'lapNumberId', label: 'Lap number value', kind: 'value' },
    UNIT_FIELD,
    {
      key: 'total',
      label: 'Total',
      kind: 'number',
      min: 0,
      hint: 'In the unit above; 0 = session total',
      dependsOn: { key: 'view', values: ['session'] },
    },
    {
      key: 'label',
      label: 'Label',
      kind: 'text',
      hint: 'Before the lap number',
      dependsOn: { key: 'view', values: ['lap'] },
    },
    { key: 'minorTicks', label: 'Minor ticks', kind: 'number', min: 0, max: 9, hint: 'Per lap' },
    ...BAR_STYLE_FIELDS,
  ],
  inputs: (props) => [props.valueId, props.lapTimeId, props.lapNumberId],
  prepare: ({ props, values }) => {
    const factor = DISTANCE_UNITS[props.unit];
    const distance = values.get(props.valueId);
    const total = barTotal(distance, props.unit, props.total);
    const laps: LapMark[] = [];
    if (distance) {
      for (const lap of lapsFromSeries(values, props.lapTimeId, props.lapNumberId)) {
        const at = valueAt(values.times, distance, lap.start) / factor;
        if (Number.isFinite(at) && at >= 0) laps.push({ ...lap, distance: at });
      }
    }
    return { total, laps };
  },
  render(ctx, frame) {
    const { props, prepared } = frame;
    const { total, laps } = prepared;
    drawBackground(ctx, frame, props);
    const current = frame.value(props.valueId) / DISTANCE_UNITS[props.unit];
    const unit = props.unit;
    const h = frame.height;

    if (props.view === 'lap') {
      // From the current lap start to the next one (before the first lap: up to its start). The
      // last lap, unfinished, is as long as the one before it.
      const index = lapIndexAt(laps, frame.time);
      const lap = laps[index];
      const from = lap?.distance ?? 0;
      const next = laps[index + 1];
      const previous = laps[index - 1];
      const length = next ? next.distance - from : previous ? from - previous.distance : Number.NaN;
      const to = length > 0 ? from + length : Math.max(from + 1e-9, total);
      const bar = drawBar(ctx, frame, props, from, to, current);
      const lapLength = to - from;
      for (let j = 1; j <= props.minorTicks; j++) {
        bar.tick(from + (lapLength * j) / (props.minorTicks + 1), false, '', 0);
      }
      bar.tick(from, true, '0', h * 0.9);
      bar.tick(to, true, formatNumber(lapLength, Math.min(props.decimals, 2)), h * 1.4);
      const done = Math.min(Math.max(current - from, 0), lapLength);
      drawBarValue(
        ctx,
        frame,
        props,
        bar,
        `${props.label} ${formatNumber(lap?.number ?? Number.NaN, 0, '-')}`.trim(),
        `${formatNumber(done, props.decimals)} / ${formatNumber(lapLength, props.decimals)} ${unit}`,
      );
      return;
    }

    const bar = drawBar(ctx, frame, props, 0, total, current);
    // A major tick labelled with the lap number where each lap starts, minor ticks splitting
    // each lap. Labels too close to the previous one (many short laps) or to the end are skipped.
    const width = h * 0.9;
    const onBar = laps.filter((lap) => lap.distance < total);
    let lastLabel = Number.NEGATIVE_INFINITY;
    onBar.forEach((lap, k) => {
      const next = onBar[k + 1]?.distance ?? total;
      for (let j = 1; j <= props.minorTicks; j++) {
        bar.tick(lap.distance + ((next - lap.distance) * j) / (props.minorTicks + 1), false, '', width);
      }
      const tx = bar.x(lap.distance);
      const fits = tx - lastLabel >= width && bar.x(total) - tx >= width * 0.75;
      if (fits) lastLabel = tx;
      bar.tick(lap.distance, true, fits ? formatNumber(lap.number, 0) : '', width);
    });
    bar.tick(total, true, formatNumber(total, Math.min(props.decimals, 1)), width);
    drawBarValue(
      ctx,
      frame,
      props,
      bar,
      `${formatNumber(current, props.decimals)} ${unit}`,
      `${formatNumber(total, props.decimals)} ${unit}`,
    );
  },
});
