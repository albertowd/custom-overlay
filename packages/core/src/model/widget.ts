import { z } from 'zod';
import { DataRangeSchema } from './data-range.js';
import { DEFAULT_PALETTE, PaletteOverridesSchema } from './palette.js';

export const WIDGET_FILE_EXTENSION = '.widget.json';

/**
 * Files saved by earlier versions may hold the whole default palette as a widget's overrides (a
 * schema bug filled them in): such a copy is no override at all.
 */
function dropCopiedDefaults(colors: unknown): unknown {
  if (typeof colors !== 'object' || colors === null) return colors;
  const entries = Object.entries(DEFAULT_PALETTE);
  const copied =
    Object.keys(colors).length === entries.length &&
    entries.every(([key, value]) => (colors as Record<string, unknown>)[key] === value);
  return copied ? {} : colors;
}

/** When widgets are drawn, in timeline seconds; a null bound is open (from the start / to the end). */
export const VisibleRangeSchema = z.object({
  start: z.number().nullable().default(null),
  end: z.number().nullable().default(null),
});

/** Show the widget only while a value meets a condition. */
export const ShowWhenSchema = z.object({
  valueId: z.string().min(1),
  condition: z.enum(['has-value', 'non-zero', 'zero', 'positive', 'negative']).default('has-value'),
});

/** The point of a widget the editor positions it by and keeps fixed when resizing. */
export const WidgetAnchorSchema = z.enum([
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
]);

/**
 * A widget placed on the overlay. Position and size are fractions of the output frame
 * (0..1), so templates work at any resolution.
 */
export const WidgetSchema = z.object({
  id: z.string().min(1),
  /** Widget type id, e.g. `speed-gauge` (see the widget registry). */
  type: z.string().min(1),
  name: z.string().default(''),
  x: z.number().default(0.05),
  y: z.number().default(0.05),
  width: z.number().positive().default(0.2),
  height: z.number().positive().default(0.2),
  /** Editing reference point; `x` / `y` stay the top-left corner whatever the anchor. */
  anchor: WidgetAnchorSchema.default('top-left'),
  opacity: z.number().min(0).max(1).default(1),
  visible: z.boolean().default(true),
  showWhen: ShowWhenSchema.nullable().default(null),
  /** Own visible time range; null follows the template's. */
  visibleRange: VisibleRangeSchema.nullable().default(null),
  /** Own data range (the values this widget reads); null follows the project's. */
  dataRange: DataRangeSchema.nullable().default(null),
  /** Override of the template anti-aliasing; null follows the template. */
  antialias: z.boolean().nullable().default(null),
  /**
   * Lap and sector values (`lap.*`, `sector.*`) from the logger or from the track lines; null
   * follows the project timing source.
   */
  timing: z.enum(['imported', 'lines']).nullable().default(null),
  /** Palette colors replaced for this widget only. */
  colors: z.preprocess(dropCopiedDefaults, PaletteOverridesSchema).default({}),
  /** Type specific settings, validated by the widget type (missing ones use its defaults). */
  props: z.record(z.string(), z.unknown()).default({}),
});

/** A single widget exported on its own (`*.widget.json`). */
export const WidgetFileSchema = z.object({
  version: z.literal(1),
  widget: WidgetSchema,
});

export type ShowWhen = z.infer<typeof ShowWhenSchema>;
export type WidgetAnchor = z.infer<typeof WidgetAnchorSchema>;
export type VisibleRange = z.infer<typeof VisibleRangeSchema>;
export type Widget = z.infer<typeof WidgetSchema>;
export type WidgetFile = z.infer<typeof WidgetFileSchema>;
