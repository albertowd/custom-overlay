import { z } from 'zod';
import { drawPanel, drawTextBox } from '../draw.js';
import { formatClock, formatTemplate, templateValueIds } from '../format.js';
import { defineWidget, type FieldSpec } from '../types.js';

const ALIGN_OPTIONS = [
  ['left', 'Left'],
  ['center', 'Center'],
  ['right', 'Right'],
] as const;

const textStyle = {
  color: z.string().default('text'),
  size: z.number().min(0.05).max(1).default(0.7),
  weight: z.enum(['400', '600', '800']).default('600'),
  align: z.enum(['left', 'center', 'right']).default('center'),
  italic: z.boolean().default(false),
  uppercase: z.boolean().default(false),
  background: z.boolean().default(false),
};

const textStyleFields: FieldSpec[] = [
  { key: 'color', label: 'Color', kind: 'color' },
  {
    key: 'size',
    label: 'Font size',
    kind: 'number',
    min: 0.05,
    max: 1,
    step: 0.05,
    hint: 'Fraction of the box height',
  },
  {
    key: 'weight',
    label: 'Weight',
    kind: 'select',
    options: [
      ['400', 'Regular'],
      ['600', 'Semibold'],
      ['800', 'Bold'],
    ],
  },
  { key: 'align', label: 'Align', kind: 'select', options: ALIGN_OPTIONS },
  { key: 'italic', label: 'Italic', kind: 'boolean' },
  { key: 'uppercase', label: 'Uppercase', kind: 'boolean' },
  { key: 'background', label: 'Background panel', kind: 'boolean' },
];

export const staticText = defineWidget({
  type: 'text',
  name: 'Text',
  description: 'Static text: a title, the driver name, the event...',
  category: 'text',
  defaultSize: { width: 0.25, height: 0.06 },
  schema: z.object({ text: z.string().default('Text'), ...textStyle }),
  fields: [{ key: 'text', label: 'Text', kind: 'textarea' }, ...textStyleFields],
  inputs: () => [],
  render(ctx, frame) {
    const { props } = frame;
    if (props.background) drawPanel(ctx, frame);
    drawTextBox(ctx, frame, props.text, { ...props, color: frame.color(props.color) });
  },
});

export const valueText = defineWidget({
  type: 'value-text',
  name: 'Value text',
  description: 'Text with live values, e.g. "Lap {lap.number}  {lap.time|duration}" or "{speed.kmh|0} km/h".',
  category: 'text',
  defaultSize: { width: 0.25, height: 0.07 },
  schema: z.object({
    template: z.string().default('{speed.kmh|0} km/h'),
    fallback: z.string().default('—'),
    ...textStyle,
    background: z.boolean().default(true),
  }),
  fields: [
    {
      key: 'template',
      label: 'Text',
      kind: 'textarea',
      hint: '{value.id} or {value.id|format}; formats: 0, 0.0, duration, duration.0, clock:HH:mm:ss',
    },
    { key: 'fallback', label: 'Without value', kind: 'text' },
    ...textStyleFields,
  ],
  inputs: (props) => templateValueIds(props.template),
  render(ctx, frame) {
    const { props } = frame;
    if (props.background) drawPanel(ctx, frame);
    const text = formatTemplate(props.template, frame.value, frame.utcOffsetMinutes, props.fallback);
    drawTextBox(ctx, frame, text, { ...props, color: frame.color(props.color) });
  },
});

export const dateTime = defineWidget({
  type: 'date-time',
  name: 'Date and time',
  description: 'Clock time of the frame (from GPS or the logger clock), with an optional date line.',
  category: 'text',
  defaultSize: { width: 0.16, height: 0.09 },
  schema: z.object({
    time: z.string().default('HH:mm:ss'),
    date: z.string().default('DD/MM/YYYY'),
    timezone: z.enum(['local', 'utc', 'custom']).default('local'),
    utcOffsetMinutes: z.number().default(0),
    color: z.string().default('text'),
    dateColor: z.string().default('textMuted'),
    background: z.boolean().default(true),
  }),
  fields: [
    { key: 'time', label: 'Time format', kind: 'text', hint: 'Tokens: HH mm ss SSS (empty to hide)' },
    { key: 'date', label: 'Date format', kind: 'text', hint: 'Tokens: YYYY MM DD (empty to hide)' },
    {
      key: 'timezone',
      label: 'Timezone',
      kind: 'select',
      options: [
        ['local', 'This computer'],
        ['utc', 'UTC'],
        ['custom', 'Custom offset'],
      ],
    },
    {
      key: 'utcOffsetMinutes',
      label: 'Offset (minutes)',
      kind: 'number',
      step: 15,
      hint: 'Used with a custom timezone',
    },
    { key: 'color', label: 'Time color', kind: 'color' },
    { key: 'dateColor', label: 'Date color', kind: 'color' },
    { key: 'background', label: 'Background panel', kind: 'boolean' },
  ],
  inputs: () => ['time.clock'],
  render(ctx, frame) {
    const { props } = frame;
    if (props.background) drawPanel(ctx, frame);
    const offset =
      props.timezone === 'utc'
        ? 0
        : props.timezone === 'custom'
          ? props.utcOffsetMinutes
          : frame.utcOffsetMinutes;
    const clock = frame.value('time.clock');
    const time = props.time ? formatClock(clock, props.time, offset, '--:--:--') : '';
    const date = props.date ? formatClock(clock, props.date, offset, '--/--/----') : '';
    if (time && date) {
      ctx.save();
      drawTextBox(ctx, { ...frame, height: frame.height * 0.62 }, time, {
        color: frame.color(props.color),
        size: 0.8,
        weight: 700,
        align: 'center',
      });
      ctx.translate(0, frame.height * 0.58);
      drawTextBox(ctx, { ...frame, height: frame.height * 0.36 }, date, {
        color: frame.color(props.dateColor),
        size: 0.75,
        weight: 500,
        align: 'center',
      });
      ctx.restore();
    } else {
      drawTextBox(ctx, frame, time || date, {
        color: frame.color(props.color),
        size: 0.7,
        weight: 700,
        align: 'center',
      });
    }
  },
});
