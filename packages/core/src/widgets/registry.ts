import { type Size, sameAspect } from '../export/canvas.js';
import { createId } from '../model/project.js';
import type { Widget } from '../model/widget.js';
import { timingValueId } from '../values/timing.js';
import { distanceBar } from './builtin/distance-bar.js';
import { dynamicImage } from './builtin/dynamic-image.js';
import { elevation } from './builtin/elevation.js';
import { gForce } from './builtin/gforce.js';
import { gpsPath } from './builtin/gps-path.js';
import { staticImage } from './builtin/image.js';
import { lapCount } from './builtin/lap-count.js';
import { lapTable } from './builtin/lap-table.js';
import { lapTimer } from './builtin/lap-timer.js';
import { liveMap } from './builtin/live-map.js';
import { shape } from './builtin/shape.js';
import { speedGauge } from './builtin/speed-gauge.js';
import { dateTime, staticText, valueText } from './builtin/text.js';
import { timespan } from './builtin/timespan.js';
import type { AnyWidgetType } from './types.js';

/** Widget types shipped with the app. */
export const BUILTIN_WIDGET_TYPES: readonly AnyWidgetType[] = [
  speedGauge,
  gForce,
  gpsPath,
  liveMap,
  distanceBar,
  elevation,
  lapTimer,
  lapCount,
  lapTable,
  dateTime,
  timespan,
  valueText,
  staticText,
  staticImage,
  dynamicImage,
  shape,
];

const registry = new Map<string, AnyWidgetType>(BUILTIN_WIDGET_TYPES.map((t) => [t.type, t]));

/** Add or replace a widget type (custom widget packages). */
export function registerWidgetType(type: AnyWidgetType): void {
  registry.set(type.type, type);
}

export function getWidgetType(type: string): AnyWidgetType | undefined {
  return registry.get(type);
}

export function widgetTypes(): AnyWidgetType[] {
  return [...registry.values()];
}

/**
 * Props of a widget with the type defaults applied. Invalid props fall back to defaults one by
 * one, so a bad value never breaks the whole widget.
 */
export function resolveWidgetProps(widget: Widget, type: AnyWidgetType): Record<string, unknown> {
  const full = type.schema.safeParse(widget.props);
  if (full.success) return full.data as Record<string, unknown>;
  const defaults = type.schema.parse({}) as Record<string, unknown>;
  const valid: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(widget.props)) {
    if (type.schema.safeParse({ [key]: value }).success) valid[key] = value;
  }
  return type.schema.safeParse(valid).success
    ? (type.schema.parse(valid) as Record<string, unknown>)
    : defaults;
}

/** A new widget of a type, centred, with default props. */
const WIDE: Size = { width: 16, height: 9 };

/**
 * Default size of a widget type on a canvas, as fractions. `defaultSize` is for a 16:9 frame:
 * other shapes get the same size relative to the short side, so a gauge stays square and as
 * big on a vertical canvas.
 */
export function defaultWidgetSize(type: AnyWidgetType, canvas?: Size): { width: number; height: number } {
  const { width, height } = type.defaultSize;
  if (!canvas || canvas.width <= 0 || canvas.height <= 0 || sameAspect(canvas, WIDE))
    return { width, height };
  const short = Math.min(canvas.width, canvas.height);
  const fraction = (pixels: number, side: number) => Math.min(0.95, Math.round((pixels / side) * 1e4) / 1e4);
  return {
    width: fraction(((width * 16) / 9) * short, canvas.width),
    height: fraction(height * short, canvas.height),
  };
}

/** A new widget of a type, centred; sized for `canvas` (the output size) when given. */
export function createWidget(typeId: string, overrides: Partial<Widget> = {}, canvas?: Size): Widget {
  const type = getWidgetType(typeId);
  if (!type) throw new Error(`Unknown widget type '${typeId}'`);
  const { width, height } = defaultWidgetSize(type, canvas);
  return {
    id: createId('w'),
    type: typeId,
    name: type.name,
    x: (1 - width) / 2,
    y: (1 - height) / 2,
    width,
    height,
    anchor: 'top-left',
    opacity: 1,
    visible: true,
    showWhen: null,
    visibleRange: null,
    dataRange: null,
    antialias: null,
    timing: null,
    colors: {},
    props: type.schema.parse({}) as Record<string, unknown>,
    ...overrides,
  };
}

/** Value ids a widget reads (its inputs and its show/hide condition). */
export function widgetInputs(widget: Widget): string[] {
  const type = getWidgetType(widget.type);
  const ids = type ? type.inputs(resolveWidgetProps(widget, type)) : [];
  if (widget.showWhen) ids.push(widget.showWhen.valueId);
  return [...new Set(ids.map((id) => timingValueId(id, widget.timing)))];
}
