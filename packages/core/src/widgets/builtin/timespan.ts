import { z } from 'zod';
import { drawPanel, drawTextBox } from '../draw.js';
import { formatDuration, parseClock } from '../format.js';
import { defineWidget } from '../types.js';

export const timespan = defineWidget({
  type: 'timespan',
  name: 'Timespan',
  description:
    'Time since a start: a clock date/time (race start) or a timeline position. Before the start it counts down, shows zero or hides.',
  category: 'text',
  defaultSize: { width: 0.16, height: 0.09 },
  schema: z.object({
    reference: z.enum(['clock', 'timeline']).default('timeline'),
    /** Wall clock start, `YYYY-MM-DD HH:mm:ss`, in the selected timezone. */
    startClock: z.string().default('2024-01-01 12:00:00'),
    timezone: z.enum(['local', 'utc', 'custom']).default('local'),
    utcOffsetMinutes: z.number().default(0),
    /** Timeline seconds of the start. */
    startTimeline: z.number().default(0),
    beforeStart: z.enum(['countdown', 'zero', 'hide']).default('countdown'),
    decimals: z.number().int().min(0).max(3).default(1),
    label: z.string().default(''),
    color: z.string().default('text'),
    countdownColor: z.string().default('warning'),
    background: z.boolean().default(true),
  }),
  fields: [
    {
      key: 'reference',
      label: 'Start from',
      kind: 'select',
      options: [
        ['timeline', 'Timeline position'],
        ['clock', 'Clock date/time'],
      ],
    },
    { key: 'startTimeline', label: 'Start (timeline)', kind: 'time' },
    { key: 'startClock', label: 'Start (date/time)', kind: 'text', hint: 'YYYY-MM-DD HH:mm:ss' },
    {
      key: 'timezone',
      label: 'Timezone of the start',
      kind: 'select',
      options: [
        ['local', 'This computer'],
        ['utc', 'UTC'],
        ['custom', 'Custom offset'],
      ],
    },
    { key: 'utcOffsetMinutes', label: 'Offset (minutes)', kind: 'number', step: 15 },
    {
      key: 'beforeStart',
      label: 'Before the start',
      kind: 'select',
      options: [
        ['countdown', 'Count down'],
        ['zero', 'Show zero'],
        ['hide', 'Hide'],
      ],
    },
    { key: 'decimals', label: 'Decimals', kind: 'number', min: 0, max: 3 },
    { key: 'label', label: 'Label', kind: 'text', hint: 'Optional line above, e.g. RACE TIME' },
    { key: 'color', label: 'Color', kind: 'color' },
    { key: 'countdownColor', label: 'Countdown color', kind: 'color' },
    { key: 'background', label: 'Background panel', kind: 'boolean' },
  ],
  inputs: (props) => [props.reference === 'clock' ? 'time.clock' : 'time.timeline'],
  render(ctx, frame) {
    const { props } = frame;
    let elapsed: number;
    if (props.reference === 'clock') {
      const offset =
        props.timezone === 'utc'
          ? 0
          : props.timezone === 'custom'
            ? props.utcOffsetMinutes
            : frame.utcOffsetMinutes;
      elapsed = (frame.value('time.clock') - parseClock(props.startClock, offset)) / 1000;
    } else {
      elapsed = frame.time - props.startTimeline;
    }
    if (elapsed < 0 && props.beforeStart === 'hide') return;
    const counting = elapsed < 0 && props.beforeStart === 'countdown';
    const shown = elapsed < 0 && !counting ? 0 : elapsed;

    if (props.background) drawPanel(ctx, frame);
    const text = formatDuration(shown, props.decimals, '--:--');
    const color = frame.color(counting ? props.countdownColor : props.color);
    if (!props.label) {
      drawTextBox(ctx, frame, text, { color, size: 0.7, weight: 700, align: 'center' });
      return;
    }
    ctx.save();
    drawTextBox(ctx, { ...frame, height: frame.height * 0.36 }, props.label, {
      color: frame.color('textMuted'),
      size: 0.75,
      weight: 600,
      align: 'center',
      uppercase: true,
    });
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
