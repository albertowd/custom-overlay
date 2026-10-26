import { z } from 'zod';

export const TRACK_FILE_EXTENSION = '.track.json';

export const GeoPointSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

/** A timing line on the map: crossing it between two GPS samples marks a lap or sector split. */
export const GateSchema = z.object({
  a: GeoPointSchema,
  b: GeoPointSchema,
});

/**
 * Where lap and sector values come from:
 * - `imported`: the logger's own lap data (e.g. RaceChrono's lap number);
 * - `lines`: crossings of the start/finish and sector lines below;
 * - `auto`: the lines once a start/finish line is set, the logger otherwise.
 */
export const TimingSourceSchema = z.enum(['auto', 'imported', 'lines']);

/** Track layout used to time laps and sectors. Saved with the project and as `*.track.json`. */
export const TrackSchema = z.object({
  name: z.string().default(''),
  startFinish: GateSchema.nullable().default(null),
  /** Sector lines in driving order; n lines make n + 1 sectors. */
  sectors: z.array(GateSchema).default([]),
  timing: TimingSourceSchema.default('auto'),
  /** Crossings closer than this to the previous one are GPS jitter, not a new lap (seconds). */
  minLapSeconds: z.number().min(0).default(10),
});

/** A track exported on its own, to reuse its lines in other sessions. */
export const TrackFileSchema = z.object({
  version: z.literal(1),
  track: TrackSchema,
});

export type GeoPoint = z.infer<typeof GeoPointSchema>;
export type Gate = z.infer<typeof GateSchema>;
export type TimingSource = z.infer<typeof TimingSourceSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type TrackFile = z.infer<typeof TrackFileSchema>;

export const DEFAULT_TRACK: Track = TrackSchema.parse({});
