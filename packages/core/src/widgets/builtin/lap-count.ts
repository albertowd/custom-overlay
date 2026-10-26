import { z } from 'zod';
import { drawPanel, drawTextBox } from '../draw.js';
import { formatNumber } from '../format.js';
import { defineWidget } from '../types.js';

export const lapCount = defineWidget({
  type: 'lap-count',
  name: 'Lap count',
  description: 'Current lap and total laps of the session, e.g. LAP 3 / 12.',
  category: 'data',
  defaultSize: { width: 0.12, height: 0.1 },
  schema: z.object({
    lapNumberId: z.string().default('lap.number'),
    lapCountId: z.string().default('lap.count'),
    label: z.string().default('Lap'),
    showTotal: z.boolean().default(true),
    beforeFirstLap: z.enum(['dashes', 'hide']).default('dashes'),
    color: z.string().default('text'),
    totalColor: z.string().default('textMuted'),
    background: z.boolean().default(true),
  }),
  fields: [
    { key: 'lapNumberId', label: 'Lap number value', kind: 'value' },
    { key: 'lapCountId', label: 'Total laps value', kind: 'value' },
    { key: 'label', label: 'Label', kind: 'text', hint: 'Empty = no label' },
    { key: 'showTotal', label: 'Total laps', kind: 'boolean' },
    {
      key: 'beforeFirstLap',
      label: 'Before the first lap',
      kind: 'select',
      options: [
        ['dashes', 'Show dashes'],
        ['hide', 'Hide'],
      ],
    },
    { key: 'color', label: 'Current lap', kind: 'color' },
    { key: 'totalColor', label: 'Total', kind: 'color' },
    { key: 'background', label: 'Background panel', kind: 'boolean' },
  ],
  inputs: (props) => [props.lapNumberId, ...(props.showTotal ? [props.lapCountId] : [])],
  render(ctx, frame) {
    const { props } = frame;
    const lap = frame.value(props.lapNumberId);
    if (!Number.isFinite(lap) && props.beforeFirstLap === 'hide') return;
    if (props.background) drawPanel(ctx, frame);

    ctx.save();
    let area = frame.height;
    if (props.label) {
      drawTextBox(ctx, { ...frame, height: frame.height * 0.36 }, props.label, {
        color: frame.color('textMuted'),
        size: 0.75,
        weight: 600,
        align: 'center',
        uppercase: true,
      });
      ctx.translate(0, frame.height * 0.32);
      area = frame.height * 0.66;
    }

    // Current lap large, "/ total" smaller on the same baseline, centred together.
    const current = formatNumber(lap, 0, '-');
    const total = props.showTotal ? ` / ${formatNumber(frame.value(props.lapCountId), 0, '-')}` : '';
    const padding = frame.unit * 6;
    const maxWidth = Math.max(1, frame.width - padding * 2);
    let size = area * 0.8;
    const measure = () => {
      ctx.font = frame.font(size, 700);
      const big = ctx.measureText(current).width;
      ctx.font = frame.font(size * 0.55, 600);
      return { big, small: total ? ctx.measureText(total).width : 0 };
    };
    let widths = measure();
    if (widths.big + widths.small > maxWidth) {
      size *= maxWidth / (widths.big + widths.small);
      widths = measure();
    }
    const left = (frame.width - widths.big - widths.small) / 2;
    const baseline = area / 2 + size * 0.36;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = frame.font(size, 700);
    ctx.fillStyle = frame.color(props.color);
    ctx.fillText(current, left, baseline);
    if (total) {
      ctx.font = frame.font(size * 0.55, 600);
      ctx.fillStyle = frame.color(props.totalColor);
      ctx.fillText(total, left + widths.big, baseline);
    }
    ctx.restore();
  },
});
