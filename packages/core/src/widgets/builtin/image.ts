import { z } from 'zod';
import { drawPanel, fitRect, roundRectPath } from '../draw.js';
import { defineWidget } from '../types.js';

export const staticImage = defineWidget({
  type: 'image',
  name: 'Image',
  description: 'A static image or vector (PNG, JPEG, WebP, SVG): logo, car number, sponsor...',
  category: 'asset',
  defaultSize: { width: 0.12, height: 0.12 },
  schema: z.object({
    /** Data URL, stored in the template so it travels with it. */
    src: z.string().default(''),
    fit: z.enum(['contain', 'cover', 'stretch']).default('contain'),
    cornerRadius: z.number().min(0).max(50).default(0),
    background: z.boolean().default(false),
  }),
  fields: [
    { key: 'src', label: 'Image', kind: 'image' },
    {
      key: 'fit',
      label: 'Fit',
      kind: 'select',
      options: [
        ['contain', 'Contain'],
        ['cover', 'Cover'],
        ['stretch', 'Stretch'],
      ],
    },
    {
      key: 'cornerRadius',
      label: 'Corner radius',
      kind: 'number',
      min: 0,
      max: 50,
      hint: '% of the smaller side',
    },
    { key: 'background', label: 'Background panel', kind: 'boolean' },
  ],
  inputs: () => [],
  render(ctx, frame) {
    const { props } = frame;
    if (props.background) drawPanel(ctx, frame);
    const image = props.src ? frame.image(props.src) : undefined;
    if (!image) {
      if (frame.editing) {
        // Placeholder, editor only.
        ctx.strokeStyle = frame.color('textMuted');
        ctx.setLineDash([frame.unit * 3, frame.unit * 3]);
        ctx.lineWidth = frame.unit;
        ctx.strokeRect(0, 0, frame.width, frame.height);
        ctx.setLineDash([]);
      }
      return;
    }
    const size = image as { width: number; height: number };
    const rect = fitRect(Number(size.width), Number(size.height), frame.width, frame.height, props.fit);
    ctx.save();
    if (props.cornerRadius > 0 || props.fit === 'cover') {
      roundRectPath(ctx, 0, 0, frame.width, frame.height, frame.unit * props.cornerRadius);
      ctx.clip();
    }
    ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
    ctx.restore();
  },
});
