import { z } from 'zod';
import { fitRect } from '../draw.js';
import { defineWidget } from '../types.js';

/** Value of an optional input, 0 when unset or missing. */
function input(id: string, value: (id: string) => number): number {
  if (!id) return 0;
  const v = value(id);
  return Number.isFinite(v) ? v : 0;
}

export const dynamicImage = defineWidget({
  type: 'dynamic-image',
  name: 'Dynamic image',
  description:
    'An image moved, rotated and scaled by values: a steering wheel turned by the steering angle, a needle, a car icon...',
  category: 'asset',
  defaultSize: { width: 0.12, height: 0.213 },
  aspectRatio: 1,
  schema: z.object({
    src: z.string().default(''),
    fit: z.enum(['contain', 'cover', 'stretch']).default('contain'),
    rotateId: z.string().default(''),
    /** Degrees per value unit. */
    rotateScale: z.number().default(1),
    rotateOffset: z.number().default(0),
    translateXId: z.string().default(''),
    /** Fraction of the box width per value unit. */
    translateXScale: z.number().default(0.01),
    translateYId: z.string().default(''),
    translateYScale: z.number().default(0.01),
    scaleId: z.string().default(''),
    /** Scale change per value unit (1 + value × factor). */
    scaleFactor: z.number().default(0.01),
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
    { key: 'rotateId', label: 'Rotate by', kind: 'value', hint: 'Empty: no rotation' },
    { key: 'rotateScale', label: 'Degrees per unit', kind: 'number', step: 0.1 },
    { key: 'rotateOffset', label: 'Rotation offset (°)', kind: 'number', step: 1 },
    { key: 'translateXId', label: 'Move X by', kind: 'value' },
    { key: 'translateXScale', label: 'Box widths per unit', kind: 'number', step: 0.001 },
    { key: 'translateYId', label: 'Move Y by', kind: 'value' },
    { key: 'translateYScale', label: 'Box heights per unit', kind: 'number', step: 0.001 },
    { key: 'scaleId', label: 'Scale by', kind: 'value' },
    { key: 'scaleFactor', label: 'Scale per unit', kind: 'number', step: 0.001 },
  ],
  inputs: (props) => [props.rotateId, props.translateXId, props.translateYId, props.scaleId].filter(Boolean),
  render(ctx, frame) {
    const { props } = frame;
    const image = props.src ? frame.image(props.src) : undefined;
    if (!image) {
      if (frame.editing) {
        ctx.strokeStyle = frame.color('textMuted');
        ctx.setLineDash([frame.unit * 3, frame.unit * 3]);
        ctx.lineWidth = frame.unit;
        ctx.strokeRect(0, 0, frame.width, frame.height);
        ctx.setLineDash([]);
      }
      return;
    }
    const angle =
      (input(props.rotateId, frame.value) * props.rotateScale + props.rotateOffset) * (Math.PI / 180);
    const dx = input(props.translateXId, frame.value) * props.translateXScale * frame.width;
    const dy = input(props.translateYId, frame.value) * props.translateYScale * frame.height;
    const scale = Math.max(0, 1 + input(props.scaleId, frame.value) * props.scaleFactor);
    const size = image as { width: number; height: number };
    const rect = fitRect(Number(size.width), Number(size.height), frame.width, frame.height, props.fit);
    ctx.save();
    ctx.translate(frame.width / 2 + dx, frame.height / 2 + dy);
    ctx.rotate(angle);
    ctx.scale(scale, scale);
    ctx.drawImage(image, rect.x - frame.width / 2, rect.y - frame.height / 2, rect.width, rect.height);
    ctx.restore();
  },
});
