import { z } from 'zod';
import { roundRectPath } from '../draw.js';
import { defineWidget } from '../types.js';

type Point = [number, number];

/** Corners of a polygon shape filling a box, inset by `b` so a border stays inside it. */
function polygon(shape: string, w: number, h: number, b: number, slant: number): Point[] {
  switch (shape) {
    case 'triangle':
      return [
        [w / 2, b],
        [w - b, h - b],
        [b, h - b],
      ];
    case 'diamond':
      return [
        [w / 2, b],
        [w - b, h / 2],
        [w / 2, h - b],
        [b, h / 2],
      ];
    case 'hexagon': {
      // Pointed left and right; regular when the box is about 1.15 × as wide as tall.
      const k = Math.min(w / 2, h * 0.29) + b;
      return [
        [k, b],
        [w - k, b],
        [w - b, h / 2],
        [w - k, h - b],
        [k, h - b],
        [b, h / 2],
      ];
    }
    default: {
      // Parallelogram: the top edge shifted right by `slant` (left when negative).
      const s = Math.max(-w / 2, Math.min(w / 2, slant));
      const left = Math.max(0, -s);
      const right = Math.max(0, s);
      return [
        [b + right, b],
        [w - b - left, b],
        [w - b - right, h - b],
        [b + left, h - b],
      ];
    }
  }
}

export const shape = defineWidget({
  type: 'shape',
  name: 'Shape',
  description:
    'A solid colour shape to build backgrounds without images: panels, slanted racing bars, circles, badges...',
  category: 'asset',
  defaultSize: { width: 0.25, height: 0.1 },
  schema: z.object({
    shape: z
      .enum(['rectangle', 'rounded', 'ellipse', 'parallelogram', 'triangle', 'diamond', 'hexagon'])
      .default('rounded'),
    color: z.string().default('background'),
    fill: z.boolean().default(true),
    /** Rounded rectangle corners, % of the smaller side. */
    cornerRadius: z.number().min(0).max(50).default(12),
    /** Parallelogram slant, % of the height (negative leans the other way). */
    slant: z.number().min(-200).max(200).default(40),
    /** % of the smaller side; 0 = no border. */
    borderWidth: z.number().min(0).max(25).default(0),
    borderColor: z.string().default('primary'),
  }),
  fields: [
    {
      key: 'shape',
      label: 'Shape',
      kind: 'select',
      options: [
        ['rectangle', 'Rectangle'],
        ['rounded', 'Rounded rectangle'],
        ['ellipse', 'Ellipse / circle'],
        ['parallelogram', 'Parallelogram (slanted)'],
        ['triangle', 'Triangle'],
        ['diamond', 'Diamond'],
        ['hexagon', 'Hexagon'],
      ],
    },
    { key: 'color', label: 'Fill', kind: 'color' },
    { key: 'fill', label: 'Filled', kind: 'boolean', hint: 'Off: border only' },
    {
      key: 'cornerRadius',
      label: 'Corner radius',
      kind: 'number',
      min: 0,
      max: 50,
      hint: 'Rounded rectangle',
    },
    { key: 'slant', label: 'Slant (%)', kind: 'number', min: -200, max: 200, step: 5, hint: 'Parallelogram' },
    {
      key: 'borderWidth',
      label: 'Border width',
      kind: 'number',
      min: 0,
      max: 25,
      step: 0.5,
      hint: '0 = none',
    },
    { key: 'borderColor', label: 'Border', kind: 'color' },
  ],
  inputs: () => [],
  render(ctx, frame) {
    const { props, width: w, height: h } = frame;
    const border = frame.unit * props.borderWidth;
    // Half the border inside the edge path is outside: inset it so it stays in the box.
    const b = border / 2;
    ctx.beginPath();
    switch (props.shape) {
      case 'rectangle':
        ctx.rect(b, b, w - border, h - border);
        break;
      case 'rounded':
        roundRectPath(ctx, b, b, w - border, h - border, frame.unit * props.cornerRadius);
        break;
      case 'ellipse':
        ctx.ellipse(w / 2, h / 2, Math.max(0, w / 2 - b), Math.max(0, h / 2 - b), 0, 0, Math.PI * 2);
        break;
      default: {
        const points = polygon(props.shape, w, h, b, (props.slant / 100) * h);
        points.forEach(([x, y], i) => {
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
      }
    }
    if (props.fill) {
      ctx.fillStyle = frame.color(props.color);
      ctx.fill();
    }
    if (border > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = border;
      ctx.strokeStyle = frame.color(props.borderColor);
      ctx.stroke();
    }
  },
});
