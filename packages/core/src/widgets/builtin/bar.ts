import { fitText, roundRectPath, withAlpha } from '../draw.js';
import type { WidgetFrame } from '../types.js';

/** Drawing shared by the progress bars (distance bar, lap bar). */

/** Meters per display unit. */
export const DISTANCE_UNITS = { km: 1000, m: 1, mi: 1609.344 } as const;
export type DistanceUnit = keyof typeof DISTANCE_UNITS;

/** Value at a timeline time, interpolated between the frames around it. */
export function valueAt(times: Float64Array, values: Float64Array, time: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0) return Number.NaN;
  if (time <= (times[0] as number)) return values[0] as number;
  if (time >= (times[hi] as number)) return values[hi] as number;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] as number) <= time) lo = mid;
    else hi = mid;
  }
  const t0 = times[lo] as number;
  const v0 = values[lo] as number;
  const v1 = values[hi] as number;
  return v0 + ((v1 - v0) * (time - t0)) / ((times[hi] as number) - t0);
}

export interface BarStyle {
  color: string;
  trackColor: string;
  textColor: string;
  showLabels: boolean;
  showValue: boolean;
}

/** A bar from `from` to `to` (display units) drawn across the widget box. */
export interface Bar {
  from: number;
  to: number;
  left: number;
  right: number;
  /** Top and height of the bar itself. */
  y: number;
  height: number;
  /** X of a position on the bar, clamped to it. */
  x(at: number): number;
  /** A tick below the bar, with an optional label fitted to `width`. */
  tick(at: number, major: boolean, label: string, width: number): void;
}

/** Lay out the bar, draw its track and its progress up to `current`. */
export function drawBar(
  ctx: CanvasRenderingContext2D,
  frame: WidgetFrame<unknown, unknown>,
  style: BarStyle,
  from: number,
  to: number,
  current: number,
): Bar {
  const h = frame.height;
  const pad = Math.min(frame.width * 0.04, h * 0.3);
  const left = pad;
  const right = frame.width - pad;
  const y = h * (style.showValue ? 0.42 : 0.3);
  const height = h * 0.14;
  const span = to > from ? to - from : 1;
  const x = (at: number) => left + ((Math.min(Math.max(at, from), to) - from) / span) * (right - left);

  roundRectPath(ctx, left, y, right - left, height, height / 2);
  ctx.fillStyle = withAlpha(frame.color(style.trackColor), 0.35);
  ctx.fill();
  if (Number.isFinite(current) && current > from) {
    roundRectPath(ctx, left, y, x(current) - left, height, height / 2);
    ctx.fillStyle = frame.color(style.color);
    ctx.fill();
  }

  const text = frame.color(style.textColor);
  const tick = (at: number, major: boolean, label: string, width: number) => {
    const tx = x(at);
    ctx.strokeStyle = text;
    ctx.lineWidth = Math.max(1, h * (major ? 0.02 : 0.012));
    ctx.beginPath();
    ctx.moveTo(tx, y + height);
    ctx.lineTo(tx, y + height + h * (major ? 0.12 : 0.07));
    ctx.stroke();
    if (label && style.showLabels) {
      ctx.fillStyle = text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      fitText(ctx, frame, label, tx, y + height + h * 0.15, width, h * 0.2, 500);
    }
  };
  return { from, to, left, right, y, height, x, tick };
}

/** The value line above the bar: a main text on the left, a muted one on the right. */
export function drawBarValue(
  ctx: CanvasRenderingContext2D,
  frame: WidgetFrame<unknown, unknown>,
  style: BarStyle,
  bar: Bar,
  main: string,
  secondary: string,
): void {
  if (!style.showValue) return;
  const h = frame.height;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = frame.color(style.textColor);
  fitText(ctx, frame, main, bar.left, bar.y / 2, bar.right - bar.left, h * 0.28, 700);
  if (secondary) {
    ctx.textAlign = 'right';
    ctx.fillStyle = frame.color('textMuted');
    fitText(ctx, frame, secondary, bar.right, bar.y / 2, (bar.right - bar.left) / 2, h * 0.2, 500);
  }
}
