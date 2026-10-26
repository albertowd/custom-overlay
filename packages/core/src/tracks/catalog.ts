import { z } from 'zod';
import { type Track, TrackFileSchema } from '../model/track.js';
import bundled from './catalog.json' with { type: 'json' };

/**
 * A track of the list shipped with the app: a `*.track.json` exported from the Track step plus
 * where the track is. It still imports as a plain track file. See README.md in this folder.
 */
export const CatalogTrackFileSchema = TrackFileSchema.extend({
  /** ISO 3166-1 alpha-2 code, upper case; the file lives in the folder of the same code. */
  country: z.string().regex(/^[A-Z]{2}$/),
  /** City and region, shown next to the name. */
  location: z.string().min(1),
});

export type CatalogTrackFile = z.infer<typeof CatalogTrackFileSchema>;

/** A known track: its id is its path in this folder (`br/guapore`). */
export interface CatalogTrack {
  id: string;
  country: string;
  location: string;
  track: Track;
}

/** One track of `catalog.json`: a track file without its version, plus its id. */
export const CatalogEntrySchema = CatalogTrackFileSchema.omit({ version: true }).extend({
  id: z.string().regex(/^[a-z]{2}\/[a-z0-9-]+$/),
});

/**
 * `catalog.json`: every track of this folder, built by `npm run tracks`. Bundled with the app and
 * downloaded by it from GitHub, so tracks added after a release are known too.
 */
export const TrackCatalogFileSchema = z.object({
  version: z.literal(1),
  tracks: z.array(z.unknown()),
});

/** Where the app downloads the latest list: the catalog of the main branch. */
export const TRACK_CATALOG_URL =
  'https://raw.githubusercontent.com/albertowd/custom-overlay/main/packages/core/src/tracks/catalog.json';

/**
 * Tracks of a catalog file. Throws when it is not a catalog (or a newer version of it); single
 * tracks that are invalid (written by a newer app) are skipped.
 */
export function parseTrackCatalog(data: unknown): CatalogTrack[] {
  return TrackCatalogFileSchema.parse(data).tracks.flatMap((item) => {
    const entry = CatalogEntrySchema.safeParse(item);
    if (!entry.success) return [];
    const { id, country, location, track } = entry.data;
    return [{ id, country, location, track }];
  });
}

/** Tracks shipped with the app. */
export const TRACK_CATALOG: readonly CatalogTrack[] = parseTrackCatalog(bundled);

/** Both lists, the tracks of `newer` replacing those of `base` with the same id (corrections). */
export function mergeTrackCatalogs(
  base: readonly CatalogTrack[],
  newer: readonly CatalogTrack[],
): CatalogTrack[] {
  const byId = new Map(base.map((entry) => [entry.id, entry]));
  for (const entry of newer) byId.set(entry.id, entry);
  return [...byId.values()];
}

export function getCatalogTrack(
  id: string,
  catalog: readonly CatalogTrack[] = TRACK_CATALOG,
): CatalogTrack | undefined {
  return catalog.find((entry) => entry.id === id);
}

/** The project track with the lines of a known track; the timing source stays the user's choice. */
export function withCatalogLines(track: Track, entry: CatalogTrack): Track {
  const { name, startFinish, sectors, minLapSeconds } = entry.track;
  return { ...track, name, startFinish, sectors, minLapSeconds };
}

/** Whether two tracks have the same start/finish and sector lines. */
export function sameLines(
  a: Pick<Track, 'startFinish' | 'sectors'>,
  b: Pick<Track, 'startFinish' | 'sectors'>,
) {
  return JSON.stringify([a.startFinish, a.sectors]) === JSON.stringify([b.startFinish, b.sectors]);
}
