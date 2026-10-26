import type { WidgetFrame } from './types.js';

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

export interface TextStyle {
  color: string;
  /** Font size as a fraction of the box height (per line). */
  size: number;
  weight: number | string;
  align: CanvasTextAlign;
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
  const padding = frame.unit * 6;
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
  const x =
    style.align === 'left' ? padding : style.align === 'right' ? frame.width - padding : frame.width / 2;
  const lineHeight = frame.height / lines.length;
  lines.forEach((line, i) => {
    ctx.fillText(line, x, lineHeight * (i + 0.5));
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
