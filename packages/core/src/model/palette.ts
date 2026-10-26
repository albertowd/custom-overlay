import { z } from 'zod';

export const HexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i, 'expected #rrggbb or #rrggbbaa');

/** Colors widgets use unless a widget explicitly overrides them. */
export const PaletteSchema = z.object({
  primary: HexColorSchema.default('#ff5a36'),
  secondary: HexColorSchema.default('#4cc9f0'),
  accent: HexColorSchema.default('#f9c74f'),
  text: HexColorSchema.default('#ffffff'),
  textMuted: HexColorSchema.default('#c7ccd4'),
  background: HexColorSchema.default('#000000a0'),
  positive: HexColorSchema.default('#3ecf8e'),
  negative: HexColorSchema.default('#ff5d6c'),
  warning: HexColorSchema.default('#f5b84b'),
});

export type Palette = z.infer<typeof PaletteSchema>;

/**
 * Colors a widget overrides. No defaults here: `PaletteSchema.partial()` would keep them and fill
 * every widget with the whole default palette, hiding the project palette.
 */
export const PaletteOverridesSchema = z.object({
  primary: HexColorSchema.optional(),
  secondary: HexColorSchema.optional(),
  accent: HexColorSchema.optional(),
  text: HexColorSchema.optional(),
  textMuted: HexColorSchema.optional(),
  background: HexColorSchema.optional(),
  positive: HexColorSchema.optional(),
  negative: HexColorSchema.optional(),
  warning: HexColorSchema.optional(),
});
export type PaletteKey = keyof Palette;

export const DEFAULT_PALETTE: Palette = PaletteSchema.parse({});
export const PALETTE_KEYS = Object.keys(DEFAULT_PALETTE) as PaletteKey[];

/**
 * A color property: a palette key (`primary`, `text`...) follows the project palette, a hex
 * color (`#ff0000`) is an explicit override.
 */
export type ColorRef = PaletteKey | `#${string}`;

export function isPaletteKey(value: string): value is PaletteKey {
  return (PALETTE_KEYS as string[]).includes(value);
}

/** CSS color of a color property; unknown values fall back to the palette text color. */
export function resolveColor(ref: string, palette: Palette): string {
  if (isPaletteKey(ref)) return palette[ref];
  return HexColorSchema.safeParse(ref).success ? ref : palette.text;
}
