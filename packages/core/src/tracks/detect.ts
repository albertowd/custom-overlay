import { getChannel, StandardChannel, type TelemetrySeries } from '../model/telemetry.js';
import type { Gate, GeoPoint, Track } from '../model/track.js';
import { gateCrossings } from '../values/timing.js';
import type { RawSamples } from '../values/types.js';
import { type CatalogTrack, TRACK_CATALOG } from './catalog.js';

/** GPS positions of one source. Only time differences matter, so any time axis works. */
export interface GpsPath {
  latitude: RawSamples;
  longitude: RawSamples;
}

/** A known track the session drove on. */
export interface TrackMatch {
  entry: CatalogTrack;
  /** Crossings of the start/finish line in the driving direction (laps started). */
  crossings: number;
  /** Lines (start/finish and sectors) the session crosses at least once. */
  linesCrossed: number;
  /** Lines of the track. */
  lines: number;
}

/** Share of a track's lines a session must cross: GPS dropouts may miss one. */
const MIN_LINES_CROSSED = 0.5;
/** Only tracks whose start/finish lies this close to the session's positions are checked (~1 km). */
const MARGIN_DEGREES = 0.01;

/** The GPS positions of a telemetry series, null without them. */
export function seriesGpsPath(series: TelemetrySeries): GpsPath | null {
  const latitude = getChannel(series, StandardChannel.latitude);
  const longitude = getChannel(series, StandardChannel.longitude);
  if (!latitude || !longitude || latitude.time.length !== longitude.time.length) return null;
  return { latitude, longitude };
}

/** Latitude and longitude limits of a set of positions. */
export interface Bounds {
  south: number;
  north: number;
  west: number;
  east: number;
}

function bounds(path: GpsPath): Bounds | null {
  let box: Bounds | null = null;
  for (let i = 0; i < path.latitude.values.length; i++) {
    const lat = path.latitude.values[i] as number;
    const lon = path.longitude.values[i] as number;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    if (!box) box = { south: lat, north: lat, west: lon, east: lon };
    box.south = Math.min(box.south, lat);
    box.north = Math.max(box.north, lat);
    box.west = Math.min(box.west, lon);
    box.east = Math.max(box.east, lon);
  }
  return box;
}

/** Limits of the positions of every path, null without positions. */
export function gpsBounds(paths: readonly GpsPath[]): Bounds | null {
  let box: Bounds | null = null;
  for (const path of paths) {
    const b = bounds(path);
    if (!b) continue;
    box = box
      ? {
          south: Math.min(box.south, b.south),
          north: Math.max(box.north, b.north),
          west: Math.min(box.west, b.west),
          east: Math.max(box.east, b.east),
        }
      : b;
  }
  return box;
}

export function boundsCentre(box: Bounds): GeoPoint {
  return { latitude: (box.south + box.north) / 2, longitude: (box.west + box.east) / 2 };
}

/** Middle of a track's start/finish line, null without one. */
export function trackCentre(track: Pick<Track, 'startFinish'>): GeoPoint | null {
  const gate = track.startFinish;
  if (!gate) return null;
  return {
    latitude: (gate.a.latitude + gate.b.latitude) / 2,
    longitude: (gate.a.longitude + gate.b.longitude) / 2,
  };
}

/** Great-circle distance in kilometres. */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function near(box: Bounds, gate: Gate): boolean {
  return [gate.a, gate.b].some(
    (p) =>
      p.latitude >= box.south - MARGIN_DEGREES &&
      p.latitude <= box.north + MARGIN_DEGREES &&
      p.longitude >= box.west - MARGIN_DEGREES &&
      p.longitude <= box.east + MARGIN_DEGREES,
  );
}

/** Best first: most of its lines crossed, then the most lines (the most precise layout), then laps. */
function compareMatches(x: TrackMatch, y: TrackMatch): number {
  return (
    y.linesCrossed / y.lines - x.linesCrossed / x.lines || y.lines - x.lines || y.crossings - x.crossings
  );
}

/**
 * Known tracks the session drove on, best first: the path crosses the start/finish line and at
 * least half of the track's lines. Several paths (chapters, sources) add up.
 */
export function detectTracks(
  paths: readonly GpsPath[],
  catalog: readonly CatalogTrack[] = TRACK_CATALOG,
): TrackMatch[] {
  const located = paths.flatMap((path) => {
    const box = bounds(path);
    return box ? [{ path, box }] : [];
  });
  const matches: TrackMatch[] = [];
  for (const entry of catalog) {
    const { startFinish, sectors, minLapSeconds } = entry.track;
    if (!startFinish) continue;
    const candidates = located.filter(({ box }) => near(box, startFinish));
    if (candidates.length === 0) continue;
    const count = (gate: Gate) =>
      candidates.reduce(
        (sum, { path }) => sum + gateCrossings(path.latitude, path.longitude, gate, minLapSeconds).length,
        0,
      );
    const crossings = count(startFinish);
    if (crossings === 0) continue;
    const lines = 1 + sectors.length;
    const linesCrossed = 1 + sectors.filter((gate) => count(gate) > 0).length;
    if (linesCrossed / lines < MIN_LINES_CROSSED) continue;
    matches.push({ entry, crossings, linesCrossed, lines });
  }
  return matches.sort(compareMatches);
}

/** The match to apply without asking: the best one, unless another track fits just as well. */
export function bestTrackMatch(matches: readonly TrackMatch[]): TrackMatch | null {
  const [first, second] = matches;
  if (!first || (second && compareMatches(first, second) === 0)) return null;
  return first;
}
