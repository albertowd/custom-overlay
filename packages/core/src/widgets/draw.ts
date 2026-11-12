import { z } from 'zod';
import type { FieldSpec, WidgetFrame } from './types.js';

/** Helpers shared by the built-in widgets (and available to custom widgets). */

/** Rounded rectangle path. */
export function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** Translucent rounded panel behind a widget, in the palette background color. */
export function drawPanel(ctx: CanvasRenderingContext2D, frame: WidgetFrame<unknown, unknown>): void {
  roundRectPath(ctx, 0, 0, frame.width, frame.height, frame.unit * 8);
  ctx.fillStyle = frame.palette.background;
  ctx.fill();
}

/**
 * Shapes of a widget background: `circle` is the largest circle centred in the box (gauges),
 * `ellipse` fills the box, `slanted` is a parallelogram leaning right.
 */
export const BACKGROUND_SHAPES = ['rounded', 'rectangle', 'pill', 'ellipse', 'circle', 'slanted'] as const;
export type BackgroundShape = (typeof BACKGROUND_SHAPES)[number];

const BACKGROUND_SHAPE_LABELS: Record<BackgroundShape, string> = {
  rounded: 'Rounded rectangle',
  rectangle: 'Rectangle',
  pill: 'Pill',
  ellipse: 'Ellipse',
  circle: 'Circle',
  slanted: 'Slanted',
};

/** Background settings of a widget, merged into its props schema (`...backgroundProps()`). */
export function backgroundProps(defaults: { enabled?: boolean; shape?: BackgroundShape } = {}) {
  return {
    background: z.boolean().default(defaults.enabled ?? true),
    backgroundColor: z.string().default('background'),
    backgroundShape: z.enum(BACKGROUND_SHAPES).default(defaults.shape ?? 'rounded'),
    /** Corner radius of a rounded background, % of the smaller side. */
    backgroundRadius: z.number().min(0).max(50).default(8),
    /** Multiplies the background color's own alpha. */
    backgroundOpacity: z.number().min(0).max(1).default(1),
  };
}

/** Editor fields of `backgroundProps`, shown once the background is on. */
export function backgroundFields(label = 'Background panel'): FieldSpec[] {
  const on = { key: 'background', values: [true] } as const;
  return [
    { key: 'background', label, kind: 'boolean' },
    { key: 'backgroundColor', label: 'Background color', kind: 'color', dependsOn: on },
    {
      key: 'backgroundShape',
      label: 'Background shape',
      kind: 'select',
      options: BACKGROUND_SHAPES.map((shape) => [shape, BACKGROUND_SHAPE_LABELS[shape]] as const),
      dependsOn: on,
    },
    {
      key: 'backgroundRadius',
      label: 'Corner radius',
      kind: 'number',
      min: 0,
      max: 50,
      hint: '% of the smaller side',
      dependsOn: { key: 'backgroundShape', values: ['rounded'] },
    },
    {
      key: 'backgroundOpacity',
      label: 'Background opacity',
      kind: 'number',
      min: 0,
      max: 1,
      step: 0.05,
      dependsOn: on,
    },
  ];
}

export interface BackgroundStyle {
  background: boolean;
  backgroundColor: string;
  backgroundShape: BackgroundShape;
  backgroundRadius: number;
  backgroundOpacity: number;
}

/** Path of a background shape filling (0, 0, width, height). */
export function backgroundPath(
  ctx: CanvasRenderingContext2D,
  shape: BackgroundShape,
  width: number,
  height: number,
  radius: number,
): void {
  switch (shape) {
    case 'rectangle':
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      break;
    case 'pill':
      roundRectPath(ctx, 0, 0, width, height, Math.min(width, height) / 2);
      break;
    case 'ellipse':
      ctx.beginPath();
      ctx.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
      break;
    case 'circle':
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, Math.min(width, height) / 2, 0, Math.PI * 2);
      break;
    case 'slanted': {
      const slant = Math.min(width / 3, height * 0.35);
      ctx.beginPath();
      ctx.moveTo(slant, 0);
      ctx.lineTo(width, 0);
      ctx.lineTo(width - slant, height);
      ctx.lineTo(0, height);
      ctx.closePath();
      break;
    }
    default:
      roundRectPath(ctx, 0, 0, width, height, radius);
  }
}

/** The widget background of `backgroundProps`, when it is on. */
export function drawBackground(
  ctx: CanvasRenderingContext2D,
  frame: WidgetFrame<unknown, unknown>,
  style: BackgroundStyle,
): void {
  if (!style.background || style.backgroundOpacity <= 0) return;
  backgroundPath(ctx, style.backgroundShape, frame.width, frame.height, frame.unit * style.backgroundRadius);
  ctx.fillStyle = withAlpha(frame.color(style.backgroundColor), style.backgroundOpacity);
  ctx.fill();
}

/** Circular panel (gauges, G-force). */
export function drawDisc(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  color: string,
): void {
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

export const TEXT_ALIGNS = ['left', 'center', 'right'] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];
export const VERTICAL_ALIGNS = ['top', 'middle', 'bottom'] as const;
export type VerticalAlign = (typeof VERTICAL_ALIGNS)[number];

/** Horizontal text alignment setting of a widget (`...textAlignProp`). */
export const textAlignProp = { align: z.enum(TEXT_ALIGNS).default('center') };
/** Vertical text alignment setting of a widget (`...verticalAlignProp`). */
export const verticalAlignProp = { verticalAlign: z.enum(VERTICAL_ALIGNS).default('middle') };

/** Editor fields of `textAlignProp` (and `verticalAlignProp` with `vertical`). */
export function textAlignFields(vertical = false): FieldSpec[] {
  const fields: FieldSpec[] = [
    {
      key: 'align',
      label: 'Align',
      kind: 'select',
      options: [
        ['left', 'Left'],
        ['center', 'Center'],
        ['right', 'Right'],
      ],
    },
  ];
  if (vertical) {
    fields.push({
      key: 'verticalAlign',
      label: 'Vertical align',
      kind: 'select',
      options: [
        ['top', 'Top'],
        ['middle', 'Middle'],
        ['bottom', 'Bottom'],
      ],
    });
  }
  return fields;
}

/** Inner margin of text in a widget box. */
export function textPadding(frame: WidgetFrame<unknown, unknown>): number {
  return frame.unit * 6;
}

/** X of text aligned in the box (with `ctx.textAlign` set to the same alignment). */
export function alignedX(frame: WidgetFrame<unknown, unknown>, align: CanvasTextAlign): number {
  const padding = textPadding(frame);
  if (align === 'left' || align === 'start') return padding;
  if (align === 'right' || align === 'end') return frame.width - padding;
  return frame.width / 2;
}

export interface TextStyle {
  color: string;
  /** Font size as a fraction of the box height (per line). */
  size: number;
  weight: number | string;
  align: CanvasTextAlign;
  /** Where the lines sit when the font leaves room above and below them; middle by default. */
  verticalAlign?: VerticalAlign;
  italic?: boolean;
  uppercase?: boolean;
}

/** Draw lines of text in the box, shrinking the font when a line is too wide. */
export function drawTextBox(
  ctx: CanvasRenderingContext2D,
  frame: WidgetFrame<unknown, unknown>,
  text: string,
  style: TextStyle,
): void {
  const lines = (style.uppercase ? text.toUpperCase() : text).split('\n');
  const padding = textPadding(frame);
  const maxWidth = Math.max(1, frame.width - padding * 2);
  let size = (frame.height * style.size) / lines.length;
  const font = (px: number) => `${style.italic ? 'italic ' : ''}${frame.font(px, style.weight)}`;
  ctx.font = font(size);
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
  if (widest > maxWidth) {
    size *= maxWidth / widest;
    ctx.font = font(size);
  }
  ctx.fillStyle = style.color;
  ctx.textAlign = style.align;
  ctx.textBaseline = 'middle';
  const x = alignedX(frame, style.align);
  // Lines keep their spacing; the block of lines (last line as tall as the font) is aligned.
  const lineHeight = frame.height / lines.length;
  const block = lineHeight * (lines.length - 1) + size;
  const margin = Math.min(frame.unit * 4, Math.max(0, (frame.height - block) / 2));
  const top =
    style.verticalAlign === 'top'
      ? margin
      : style.verticalAlign === 'bottom'
        ? frame.height - block - margin
        : (frame.height - block) / 2;
  lines.forEach((line, i) => {
    ctx.fillText(line, x, top + size / 2 + lineHeight * i);
  });
}

/** Draw a single line centred at (x, y), fitted to `maxWidth`. */
export function fitText(
  ctx: CanvasRenderingContext2D,
  frame: WidgetFrame<unknown, unknown>,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  sizePx: number,
  weight: number | string = 600,
): void {
  ctx.font = frame.font(sizePx, weight);
  const width = ctx.measureText(text).width;
  if (width > maxWidth && width > 0) ctx.font = frame.font((sizePx * maxWidth) / width, weight);
  ctx.fillText(text, x, y);
}

/** Round up to 1, 2 or 5 × 10^n. */
export function niceCeil(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * magnitude >= value) return step * magnitude;
  return 10 * magnitude;
}

/** A readable step splitting `range` in about `count` parts. */
export function niceStep(range: number, count = 5): number {
  const raw = range / count;
  if (!(raw > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const nice = normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10;
  return nice * magnitude;
}

/** Largest finite value of an array, NaN when none. */
export function maxOf(values: Float64Array | undefined): number {
  let max = Number.NaN;
  if (!values) return max;
  for (const v of values) if (Number.isFinite(v) && (Number.isNaN(max) || v > max)) max = v;
  return max;
}

/** Smallest finite value of an array, NaN when none. */
export function minOf(values: Float64Array | undefined): number {
  let min = Number.NaN;
  if (!values) return min;
  for (const v of values) if (Number.isFinite(v) && (Number.isNaN(min) || v < min)) min = v;
  return min;
}

/** Destination rectangle of an image fitted in a box. */
export function fitRect(
  imageWidth: number,
  imageHeight: number,
  width: number,
  height: number,
  fit: 'contain' | 'cover' | 'stretch',
): { x: number; y: number; width: number; height: number } {
  if (fit === 'stretch' || imageWidth <= 0 || imageHeight <= 0) return { x: 0, y: 0, width, height };
  const scale =
    fit === 'contain'
      ? Math.min(width / imageWidth, height / imageHeight)
      : Math.max(width / imageWidth, height / imageHeight);
  const w = imageWidth * scale;
  const h = imageHeight * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}

export interface MarkerStyle {
  /** Image data URL; empty draws the built-in shape. */
  src: string;
  /** Size in pixels. */
  size: number;
  /** Direction the image points to, in degrees from up (e.g. 90 for an image facing right). */
  angle: number;
  /** Fill of the built-in shape. */
  color: string;
  shape: 'arrow' | 'dot';
}

/**
 * Position marker centred at (x, y) pointing to `rotation` (radians clockwise from up): the
 * image when set (nothing while it loads), else an arrow or a dot.
 */
export function drawMarker(
  ctx: CanvasRenderingContext2D,
  frame: WidgetFrame<unknown, unknown>,
  x: number,
  y: number,
  rotation: number,
  style: MarkerStyle,
): void {
  const size = style.size;
  ctx.save();
  ctx.translate(x, y);
  if (style.src) {
    const image = frame.image(style.src);
    if (image) {
      ctx.rotate(rotation - style.angle * (Math.PI / 180));
      const dims = image as { width: number; height: number };
      const rect = fitRect(Number(dims.width), Number(dims.height), size, size, 'contain');
      ctx.drawImage(image, rect.x - size / 2, rect.y - size / 2, rect.width, rect.height);
    }
  } else if (style.shape === 'dot') {
    drawDisc(ctx, 0, 0, size / 2, frame.palette.background);
    drawDisc(ctx, 0, 0, size * 0.35, style.color);
  } else {
    ctx.rotate(rotation);
    ctx.beginPath();
    ctx.moveTo(0, -size / 2);
    ctx.lineTo(size * 0.38, size / 2);
    ctx.lineTo(0, size * 0.28);
    ctx.lineTo(-size * 0.38, size / 2);
    ctx.closePath();
    ctx.fillStyle = style.color;
    ctx.fill();
    ctx.strokeStyle = frame.palette.background;
    ctx.lineWidth = size * 0.07;
    ctx.stroke();
  }
  ctx.restore();
}

/** Color with an alpha multiplier (accepts #rrggbb / #rrggbbaa). */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
  if (!hex) return color;
  const base = hex[2] ? Number.parseInt(hex[2], 16) / 255 : 1;
  const a = Math.round(Math.max(0, Math.min(1, base * alpha)) * 255);
  return `#${hex[1]}${a.toString(16).padStart(2, '0')}`;
}
