import { z } from 'zod';
import { drawPanel, drawTextBox } from '../draw.js';
import { formatDuration } from '../format.js';
import { bestLapTime, formatDelta, type Lap, lapIndexAt, lapsFromSeries } from '../laps.js';
import { defineWidget } from '../types.js';

export const lapTimer = defineWidget({
  type: 'lap-timer',
  name: 'Lap timer',
  description:
    'Running time of the current lap. When a lap ends its final time stays on screen for a few seconds, with the gap to the best or previous lap.',
  category: 'data',
  defaultSize: { width: 0.18, height: 0.1 },
  schema: z.object({
    lapTimeId: z.string().default('lap.time'),
    lapNumberId: z.string().default('lap.number'),
    /** Seconds the final time of a finished lap stays on screen; 0 = never. */
    holdSeconds: z.number().min(0).default(5),
    delta: z.enum(['best', 'previous', 'none']).default('best'),
    decimals: z.number().int().min(0).max(3).default(3),
    showLapNumber: z.boolean().default(true),
    beforeFirstLap: z.enum(['dashes', 'hide']).default('dashes'),
    color: z.string().default('text'),
    bestColor: z.string().default('accent'),
    background: z.boolean().default(true),
  }),
  fields: [
    { key: 'lapTimeId', label: 'Lap time value (s)', kind: 'value' },
    { key: 'lapNumberId', label: 'Lap number value', kind: 'value' },
    {
      key: 'holdSeconds',
      label: 'Show finished lap for (s)',
      kind: 'number',
      min: 0,
      step: 0.5,
      hint: '0 = go straight to the new lap',
    },
    {
      key: 'delta',
      label: 'Finished lap gap to',
      kind: 'select',
      options: [
        ['best', 'Best lap so far'],
        ['previous', 'Previous lap'],
        ['none', 'No gap'],
      ],
    },
    { key: 'decimals', label: 'Decimals', kind: 'number', min: 0, max: 3 },
    { key: 'showLapNumber', label: 'Lap number', kind: 'boolean' },
    {
      key: 'beforeFirstLap',
      label: 'Before the first lap',
      kind: 'select',
      options: [
        ['dashes', 'Show dashes'],
        ['hide', 'Hide'],
      ],
    },
    { key: 'color', label: 'Time', kind: 'color' },
    { key: 'bestColor', label: 'New best lap', kind: 'color' },
    { key: 'background', label: 'Background panel', kind: 'boolean' },
  ],
  inputs: (props) => [props.lapTimeId, props.lapNumberId],
  prepare: ({ props, values }): Lap[] => lapsFromSeries(values, props.lapTimeId, props.lapNumberId),
  render(ctx, frame) {
    const { props, prepared: laps } = frame;
    const index = lapIndexAt(laps, frame.time);
    const current = laps[index];
    const finished = laps[index - 1];
    const holding =
      current !== undefined && finished !== undefined && frame.time - current.start < props.holdSeconds;

    let time: number;
    let lap: Lap | undefined;
    let gap = Number.NaN;
    let isBest = false;
    if (holding) {
      lap = finished;
      time = finished.duration;
      const best = bestLapTime(laps.slice(0, index - 1));
      isBest = !(finished.duration >= best);
      const reference = props.delta === 'previous' ? (laps[index - 2]?.duration ?? Number.NaN) : best;
      if (props.delta !== 'none') gap = finished.duration - reference;
    } else {
      lap = current;
      // The value itself (not the lap start) so typed test values show.
      const value = frame.value(props.lapTimeId);
      time = Number.isFinite(value) || !current ? value : frame.time - current.start;
    }
    if (!Number.isFinite(time) && props.beforeFirstLap === 'hide') return;

    if (props.background) drawPanel(ctx, frame);
    const text = formatDuration(time, props.decimals, '-:--');
    const color = frame.color(holding && isBest ? props.bestColor : props.color);
    const gapText = formatDelta(gap, props.decimals);
    const lapNumber = frame.value(props.lapNumberId);
    const number = lap?.number ?? lapNumber;
    const label = props.showLapNumber && Number.isFinite(number) ? `Lap ${number}` : '';
    if (!label && !gapText) {
      drawTextBox(ctx, frame, text, { color, size: 0.7, weight: 700, align: 'center' });
      return;
    }
    ctx.save();
    const top = { ...frame, height: frame.height * 0.36 };
    if (label) {
      drawTextBox(ctx, top, label, {
        color: frame.color('textMuted'),
        size: 0.75,
        weight: 600,
        align: gapText ? 'left' : 'center',
        uppercase: true,
      });
    }
    if (gapText) {
      drawTextBox(ctx, top, gapText, {
        color: frame.color(gap < 0 ? 'positive' : gap > 0 ? 'negative' : 'textMuted'),
        size: 0.75,
        weight: 700,
        align: label ? 'right' : 'center',
      });
    }
    ctx.translate(0, frame.height * 0.32);
    drawTextBox(ctx, { ...frame, height: frame.height * 0.66 }, text, {
      color,
      size: 0.8,
      weight: 700,
      align: 'center',
    });
    ctx.restore();
  },
});
