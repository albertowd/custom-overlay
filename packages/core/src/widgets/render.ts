import { rotatedSize } from '../export/canvas.js';
import { type Palette, resolveColor } from '../model/palette.js';
import type { Template, VideoRotation } from '../model/project.js';
import type { ShowWhen, VisibleRange, Widget } from '../model/widget.js';
import { timingValueId } from '../values/timing.js';
import { localUtcOffsetMinutes } from './format.js';
import { getWidgetType, resolveWidgetProps } from './registry.js';
import type { AnyWidgetType, ValueSeries, WidgetFrame } from './types.js';

/** A canvas to draw a widget on before compositing (anti-aliasing by supersampling). */
export interface ScratchCanvas {
  canvas: CanvasImageSource;
  ctx: CanvasRenderingContext2D;
}

export interface OverlayFrame {
  /** Whole-session values (one number per frame). */
  series: ValueSeries;
  /**
   * Values of a widget when they differ from `series` (a widget with its own data range). Must
   * return the same object for the same range, as prepared data is cached per series.
   */
  seriesFor?(widget: Widget): ValueSeries;
  /** Frame to draw, index in the series (-1 without data). */
  frameIndex: number;
  /** Timeline time of the frame. */
  time: number;
}

export interface RenderOverlayOptions {
  /** Pixel size of the target (the output frame). */
  width: number;
  height: number;
  /**
   * Clockwise turn of the widgets (with a turned video, see `widgetRotation`): they are laid out
   * on the target turned back, then turned onto it.
   */
  rotation?: VideoRotation;
  template: Template;
  palette: Palette;
  frame: OverlayFrame;
  /** Values typed by the user to test widgets; they replace the real ones. */
  testValues?: Readonly<Record<string, number>>;
  /** Decoded images by data URL (undefined while loading). */
  image?(src: string): CanvasImageSource | undefined;
  /** Scratch canvases for anti-aliasing; without it widgets are drawn directly. */
  createCanvas?(width: number, height: number): ScratchCanvas;
  /** Prepared data reused between frames (see createPreparedCache). */
  cache?: PreparedCache;
  utcOffsetMinutes?: number;
  /** Draw editor-only placeholders. */
  editing?: boolean;
  /** Ignore show/hide conditions and visible ranges (draw every visible widget). */
  ignoreShowWhen?: boolean;
}

/** Errors by widget id. */
export type RenderReport = Record<string, string>;

/** Remembers each widget's prepared data while its props and the value series do not change. */
export interface PreparedCache {
  entries: Map<string, { key: string; series: ValueSeries; data: unknown }>;
}

export function createPreparedCache(): PreparedCache {
  return { entries: new Map() };
}

function prepared(
  type: AnyWidgetType,
  widget: Widget,
  props: Record<string, unknown>,
  series: ValueSeries,
  cache?: PreparedCache,
): unknown {
  if (!type.prepare) return undefined;
  const key = `${widget.type}:${widget.timing}:${JSON.stringify(props)}`;
  const hit = cache?.entries.get(widget.id);
  if (hit && hit.key === key && hit.series === series) return hit.data;
  const values: ValueSeries = widget.timing
    ? { times: series.times, get: (id) => series.get(timingValueId(id, widget.timing)) }
    : series;
  const data = type.prepare({ props, values });
  cache?.entries.set(widget.id, { key, series, data });
  return data;
}

/** Whether a time is inside a visible range (open bounds included). */
export function inVisibleRange(range: VisibleRange, time: number): boolean {
  return (range.start === null || time >= range.start) && (range.end === null || time < range.end);
}

/** The range a widget is drawn in: its own, or the template's. */
export function widgetVisibleRange(widget: Widget, template: Pick<Template, 'visibleRange'>): VisibleRange {
  return widget.visibleRange ?? template.visibleRange;
}

/** Whether a show/hide condition holds for a value. */
export function showWhenHolds(condition: ShowWhen, value: number): boolean {
  switch (condition.condition) {
    case 'has-value':
      return !Number.isNaN(value);
    case 'non-zero':
      return !Number.isNaN(value) && value !== 0;
    case 'zero':
      return value === 0;
    case 'positive':
      return value > 0;
    case 'negative':
      return value < 0;
    default:
      return true;
  }
}

/**
 * Value lookup at the frame, test values first. With a timing family, lap and sector ids read
 * that family (`lap.time` → `lines.lap.time`); test values may use either id.
 */
export function frameValue(
  options: Pick<RenderOverlayOptions, 'frame' | 'testValues'>,
  timing: Widget['timing'] = null,
): (id: string) => number {
  const { series, frameIndex } = options.frame;
  return (id) => {
    const read = timingValueId(id, timing);
    const test = options.testValues?.[read] ?? options.testValues?.[id];
    if (test !== undefined && Number.isFinite(test)) return test;
    if (frameIndex < 0) return Number.NaN;
    return series.get(read)?.[frameIndex] ?? Number.NaN;
  };
}

/** Pixel rectangle of a widget in the output frame. */
export function widgetRect(widget: Widget, width: number, height: number) {
  return {
    x: widget.x * width,
    y: widget.y * height,
    width: widget.width * width,
    height: widget.height * height,
  };
}

/**
 * Draw every visible widget of a template, in order (first is at the back), on a transparent
 * target. Errors are reported per widget and never stop the other widgets.
 */
export function renderOverlay(ctx: CanvasRenderingContext2D, options: RenderOverlayOptions): RenderReport {
  const rotation = options.rotation ?? 0;
  if (rotation === 0) return renderWidgets(ctx, options);
  const { width, height } = options;
  ctx.save();
  try {
    // Maps the turned-back frame onto the target: its top-left goes to the top-right for 90°.
    if (rotation === 90) ctx.translate(width, 0);
    else if (rotation === 180) ctx.translate(width, height);
    else ctx.translate(0, height);
    ctx.rotate((rotation * Math.PI) / 180);
    return renderWidgets(ctx, { ...options, ...rotatedSize({ width, height }, rotation), rotation: 0 });
  } finally {
    ctx.restore();
  }
}

function renderWidgets(ctx: CanvasRenderingContext2D, options: RenderOverlayOptions): RenderReport {
  const report: RenderReport = {};
  const utcOffsetMinutes = options.utcOffsetMinutes ?? localUtcOffsetMinutes();
  for (const widget of options.template.widgets) {
    if (!widget.visible) continue;
    if (
      !options.ignoreShowWhen &&
      !inVisibleRange(widgetVisibleRange(widget, options.template), options.frame.time)
    ) {
      continue;
    }
    // A widget with its own data range reads its own values.
    const overlayFrame = options.frame.seriesFor
      ? { ...options.frame, series: options.frame.seriesFor(widget) }
      : options.frame;
    const value = frameValue({ ...options, frame: overlayFrame }, widget.timing);
    if (
      !options.ignoreShowWhen &&
      widget.showWhen &&
      !showWhenHolds(widget.showWhen, value(widget.showWhen.valueId))
    ) {
      continue;
    }
    const type = getWidgetType(widget.type);
    if (!type) {
      report[widget.id] = `unknown widget type '${widget.type}'`;
      continue;
    }
    const rect = widgetRect(widget, options.width, options.height);
    if (rect.width < 1 || rect.height < 1) continue;
    try {
      const props = resolveWidgetProps(widget, type);
      const palette = { ...options.palette, ...widget.colors };
      const font = options.template.font;
      const antialias = widget.antialias ?? options.template.antialias;
      const scale = antialias && options.createCanvas ? 2 : 1;
      const frame: WidgetFrame<Record<string, unknown>, unknown> = {
        props,
        width: rect.width * scale,
        height: rect.height * scale,
        unit: (Math.min(rect.width, rect.height) * scale) / 100,
        palette,
        color: (ref) => resolveColor(ref, palette),
        font: (size, weight = 400) => `${weight} ${Math.max(1, size).toFixed(1)}px ${font}`,
        value,
        time: options.frame.time,
        frameIndex: options.frame.frameIndex,
        prepared: prepared(type, widget, props, overlayFrame.series, options.cache),
        image: (src) => options.image?.(src),
        utcOffsetMinutes,
        editing: options.editing ?? false,
      };

      if (scale > 1 && options.createCanvas) {
        const scratch = options.createCanvas(Math.ceil(frame.width), Math.ceil(frame.height));
        type.render(scratch.ctx, frame);
        ctx.save();
        ctx.globalAlpha = widget.opacity;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(scratch.canvas, rect.x, rect.y, rect.width, rect.height);
        ctx.restore();
      } else {
        ctx.save();
        ctx.globalAlpha = widget.opacity;
        ctx.translate(rect.x, rect.y);
        type.render(ctx, frame);
        ctx.restore();
      }
    } catch (error) {
      report[widget.id] = error instanceof Error ? error.message : String(error);
    }
  }
  return report;
}
