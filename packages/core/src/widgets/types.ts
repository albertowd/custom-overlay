import type { z } from 'zod';
import type { Palette } from '../model/palette.js';

/** Whole-session access to values, for widgets that precompute (paths, profiles, totals). */
export interface ValueSeries {
  /** One number per frame (NaN = no value), or undefined for unknown ids. */
  get(id: string): Float64Array | undefined;
  /** Timeline time of each frame. */
  times: Float64Array;
}

/** Everything a widget needs to draw one frame. */
export interface WidgetFrame<Props, Prepared = undefined> {
  props: Props;
  /** Size of the widget box in pixels; draw inside (0, 0, width, height). */
  width: number;
  height: number;
  /** One percent of the smaller box side, in pixels: use it for line widths and margins. */
  unit: number;
  /** Project palette with the widget's own color overrides applied. */
  palette: Palette;
  /** CSS color of a color property (palette key or hex). */
  color(ref: string): string;
  /** CSS font: size in pixels, weight, then the widget / template font family. */
  font(sizePx: number, weight?: number | string): string;
  /** Value at the current frame, NaN when there is none. */
  value(id: string): number;
  /** Timeline time of the frame, in seconds. */
  time: number;
  /** Index of the frame in the value series (-1 without data). */
  frameIndex: number;
  /** Result of `prepare` (computed once per data / props change). */
  prepared: Prepared;
  /** Decoded image for a data URL, undefined while loading (the frame is redrawn once loaded). */
  image(src: string): CanvasImageSource | undefined;
  /** UTC offset in minutes to display clock values in (local machine time by default). */
  utcOffsetMinutes: number;
  /** True in the editor: draw placeholders (never shown in exports). */
  editing: boolean;
}

export interface PrepareInput<Props> {
  props: Props;
  values: ValueSeries;
}

/** A field shown only while another setting has one of these values (and that field is shown). */
export interface FieldDependency {
  key: string;
  values: readonly unknown[];
}

interface FieldBase {
  key: string;
  label: string;
  hint?: string;
  dependsOn?: FieldDependency;
}

/** Editor field kinds, used to build the property panel. */
export type FieldSpec =
  | (FieldBase & { kind: 'number'; min?: number; max?: number; step?: number })
  /** A timeline position in seconds, typed as a timecode (`2:30`, `530` = 0.530 s). */
  | (FieldBase & { kind: 'time' })
  | (FieldBase & { kind: 'text' | 'textarea' })
  | (FieldBase & { kind: 'boolean' })
  | (FieldBase & { kind: 'select'; options: readonly (readonly [string, string])[] })
  /** Palette key or hex color. */
  | (FieldBase & { kind: 'color' })
  /** A value id. */
  | (FieldBase & { kind: 'value' })
  /** An image as a data URL (PNG, JPEG, SVG...). */
  | (FieldBase & { kind: 'image' });

/** Whether a field is shown with these props (its dependencies, and theirs, hold). */
export function fieldShown(
  field: FieldSpec,
  fields: readonly FieldSpec[],
  props: Readonly<Record<string, unknown>>,
): boolean {
  const seen = new Set<string>();
  let current: FieldSpec | undefined = field;
  while (current?.dependsOn && !seen.has(current.key)) {
    seen.add(current.key);
    const dependency: FieldDependency = current.dependsOn;
    if (!dependency.values.includes(props[dependency.key])) return false;
    current = fields.find((f) => f.key === dependency.key);
  }
  return true;
}

/**
 * A widget type. Props are validated with `schema` (defaults fill missing props), `render` draws
 * one frame on a Canvas 2D context with a transparent background.
 */
export interface WidgetType<Props = Record<string, unknown>, Prepared = undefined> {
  type: string;
  name: string;
  description: string;
  category: 'data' | 'text' | 'map' | 'asset';
  /**
   * Default size as fractions of a 16:9 output frame; on other canvas shapes it keeps the same
   * size relative to the short side (see `defaultWidgetSize`).
   */
  defaultSize: { width: number; height: number };
  /** Pixel aspect ratio (width / height) to keep when resizing, if any (1 = square). */
  aspectRatio?: number;
  schema: z.ZodType<Props>;
  fields: readonly FieldSpec[];
  /** Value ids the widget reads with these props. */
  inputs(props: Props): string[];
  /** Precompute from whole-session values. */
  prepare?(input: PrepareInput<Props>): Prepared;
  render(ctx: CanvasRenderingContext2D, frame: WidgetFrame<Props, Prepared>): void;
}

/** A widget type with its props type erased, as stored in the registry. */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous registry of widget types
export type AnyWidgetType = WidgetType<any, any>;

/** Define a widget type with props inferred from its schema. */
export function defineWidget<S extends z.ZodType, Prepared = undefined>(
  definition: Omit<WidgetType<z.infer<S>, Prepared>, 'schema'> & { schema: S },
): WidgetType<z.infer<S>, Prepared> {
  return definition as WidgetType<z.infer<S>, Prepared>;
}
