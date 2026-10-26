import { z } from 'zod';

export const VALUES_FILE_EXTENSION = '.values.json';

/** Value ids: dotted lower camel/snake segments, e.g. `speed`, `lap.time`, `racechrono.lateralAcc`. */
export const VALUE_ID_PATTERN = /^[a-z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)*$/;

/** A user value: a script computing one number per frame from other values. */
export const ValueScriptSchema = z.object({
  id: z.string().regex(VALUE_ID_PATTERN, 'ids are dotted names like "lap.delta" or "speed_avg"'),
  name: z.string().min(1),
  description: z.string().default(''),
  unit: z.string().default(''),
  /** Used for frames without a value; null leaves them empty (widgets can hide). */
  initial: z.number().nullable().default(null),
  /** Body of `function (ctx) { ... }` returning an array (one number per frame) or a number. */
  code: z.string(),
});

/** Importable / exportable set of value scripts ("my car values"). */
export const ValueCollectionSchema = z.object({
  version: z.literal(1),
  name: z.string().default('Untitled values'),
  values: z.array(ValueScriptSchema).default([]),
});

export type ValueScript = z.infer<typeof ValueScriptSchema>;
export type ValueCollection = z.infer<typeof ValueCollectionSchema>;
