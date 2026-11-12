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

/**
 * Widgets saved before the lap bar existed: a distance bar with lap ticks is now a lap bar (the
 * settings that only made sense with distance ticks go).
 */
function migrateWidget(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) return data;
  const widget = data as { type?: unknown; props?: unknown };
  const props = widget.props;
  if (widget.type !== 'distance-bar' || typeof props !== 'object' || props === null) return data;
  if ((props as Record<string, unknown>).ticks !== 'laps') return data;
  const kept: Record<string, unknown> = { ...props };
  delete kept.ticks;
  delete kept.tickStep;
  return { ...widget, type: 'lap-bar', props: kept };
}

/**
 * Widgets grouped to be moved, shown and aligned together. Positions stay stored in the frame;
 * the group origin is the point the positions of its relative members are shown from.
 */
export const WidgetGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().default('Group'),
  /** Hides every member when false (members keep their own visibility). */
  visible: z.boolean().default(true),
  /** Origin of the relative positions, fractions of the frame (moves with the group). */
  x: z.number().default(0),
  y: z.number().default(0),
});

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
export const WidgetSchema = z.preprocess(
  migrateWidget,
  z.object({
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
    /** Group the widget belongs to, null when it is on its own. */
    groupId: z.string().nullable().default(null),
    /**
     * In a group: `relative` widgets move with the group and show their position from its origin,
     * `absolute` ones stay put in the frame.
     */
    groupPosition: z.enum(['relative', 'absolute']).default('relative'),
  }),
);

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
export type WidgetGroup = z.infer<typeof WidgetGroupSchema>;
