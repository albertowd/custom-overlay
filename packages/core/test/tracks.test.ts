import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTrackFile } from '../src/model/project.js';
import type { TelemetrySeries } from '../src/model/telemetry.js';
import { DEFAULT_TRACK, type Gate } from '../src/model/track.js';
import {
  type CatalogTrack,
  CatalogTrackFileSchema,
  getCatalogTrack,
  mergeTrackCatalogs,
  parseTrackCatalog,
  sameLines,
  TRACK_CATALOG,
  withCatalogLines,
} from '../src/tracks/catalog.js';
import {
  bestTrackMatch,
  boundsCentre,
  detectTracks,
  distanceKm,
  type GpsPath,
  gpsBounds,
  seriesGpsPath,
  trackCentre,
} from '../src/tracks/detect.js';

const folder = new URL('../src/tracks/', import.meta.url);

/** Every `<country>/<name>.track.json` of the tracks folder, as catalog ids. */
function catalogFiles(): string[] {
  return readdirSync(folder, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) =>
      readdirSync(new URL(`${d.name}/`, folder))
        .filter((f) => f.endsWith('.track.json'))
        .map((f) => `${d.name}/${f.slice(0, -'.track.json'.length)}`),
    );
}

describe('track catalog', () => {
  it('has an up to date catalog.json (run `npm run tracks` after changing a track)', () => {
    const catalog = JSON.parse(readFileSync(new URL('catalog.json', folder), 'utf8'));
    const expected = catalogFiles()
      .sort()
      .map((id) => {
        const { version: _, ...file } = JSON.parse(readFileSync(new URL(`${id}.track.json`, folder), 'utf8'));
        return { id, ...file };
      });
    expect(catalog).toEqual({ version: 1, tracks: expected });
    expect(TRACK_CATALOG.map((e) => e.id)).toEqual(expected.map((e) => e.id));
  });

  it('reads a downloaded catalog, skipping tracks it does not understand', () => {
    const [guapore] = TRACK_CATALOG;
    const tracks = [guapore, { id: 'xx/broken', country: 'XX' }, { ...guapore, id: 'Bad id' }];
    expect(parseTrackCatalog({ version: 1, tracks }).map((e) => e.id)).toEqual(['br/guapore']);
    expect(() => parseTrackCatalog({ version: 2, tracks: [] })).toThrow();
    expect(() => parseTrackCatalog('<html>')).toThrow();
  });

  it('merges a downloaded catalog over the bundled one', () => {
    const fixed = { ...(TRACK_CATALOG[0] as CatalogTrack), location: 'Fixed' };
    const added = { ...fixed, id: 'it/new' };
    const merged = mergeTrackCatalogs(TRACK_CATALOG, [fixed, added]);
    expect(merged).toHaveLength(TRACK_CATALOG.length + 1);
    expect(getCatalogTrack('br/guapore', merged)?.location).toBe('Fixed');
    expect(getCatalogTrack('it/new', merged)).toBe(added);
    expect(getCatalogTrack('br/taruma', merged)).toBe(getCatalogTrack('br/taruma'));
  });

  it('measures distances to tracks', () => {
    const guapore = trackCentre((getCatalogTrack('br/guapore') as CatalogTrack).track);
    const taruma = trackCentre((getCatalogTrack('br/taruma') as CatalogTrack).track);
    // Guaporé to Tarumã (Viamão) is about 150 km as the crow flies.
    expect(distanceKm(guapore as never, taruma as never)).toBeGreaterThan(140);
    expect(distanceKm(guapore as never, taruma as never)).toBeLessThan(160);
    expect(trackCentre(DEFAULT_TRACK)).toBeNull();
  });

  it.each(catalogFiles())('%s is a valid, named track in its country folder', (id) => {
    const data = JSON.parse(readFileSync(new URL(`${id}.track.json`, folder), 'utf8'));
    const file = CatalogTrackFileSchema.parse(data);
    expect(id.split('/')[0]).toMatch(/^[a-z]{2}$/);
    expect(file.country).toBe(id.split('/')[0]?.toUpperCase());
    expect(file.track.name.trim()).not.toBe('');
    expect(file.track.startFinish).not.toBeNull();
    // Still a plain track file for "Import lines…".
    expect(parseTrackFile(data).track.startFinish).toEqual(file.track.startFinish);
  });

  it('has unique names', () => {
    const names = TRACK_CATALOG.map((e) => e.track.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('loads the lines and keeps the timing source', () => {
    const entry = getCatalogTrack('br/guapore') as CatalogTrack;
    const track = withCatalogLines({ ...DEFAULT_TRACK, timing: 'lines', name: 'mine' }, entry);
    expect(track.timing).toBe('lines');
    expect(track.name).toBe(entry.track.name);
    expect(sameLines(track, entry.track)).toBe(true);
    expect(sameLines(DEFAULT_TRACK, entry.track)).toBe(false);
  });
});

// --- Detection on a synthetic circuit ---------------------------------------------------------

const LAT0 = -23.7;
const LON0 = -46.7;
const K = (Math.PI / 180) * 6_371_000;
const toGeo = (x: number, y: number) => ({
  latitude: LAT0 + y / K,
  longitude: LON0 + x / (K * Math.cos(LAT0 * (Math.PI / 180))),
});
/** A radial line across a 100 m radius circle at an angle (degrees anticlockwise from east). */
const radial = (degrees: number, radius = 100): Gate => {
  const a = (degrees * Math.PI) / 180;
  return {
    a: toGeo((radius - 20) * Math.cos(a), (radius - 20) * Math.sin(a)),
    b: toGeo((radius + 20) * Math.cos(a), (radius + 20) * Math.sin(a)),
  };
};

/** Positions of a 100 m radius circle driven anticlockwise, one lap every 30 s at 10 Hz. */
function circle(seconds: number, fromDegrees = 0, toDegrees = 360): GpsPath {
  const time = new Float64Array(seconds * 10 + 1).map((_, i) => i / 10);
  const angle = time.map((t) => {
    const lapAngle = (((t / 30) * 360) % 360) as number;
    return lapAngle >= fromDegrees && lapAngle <= toDegrees ? (lapAngle * Math.PI) / 180 : Number.NaN;
  });
  const geo = Array.from(angle, (a) =>
    Number.isNaN(a) ? null : toGeo(100 * Math.cos(a), 100 * Math.sin(a)),
  );
  return {
    latitude: { time, values: Float64Array.from(geo, (g) => g?.latitude ?? Number.NaN) },
    longitude: { time, values: Float64Array.from(geo, (g) => g?.longitude ?? Number.NaN) },
  };
}

const known = (id: string, startFinish: Gate, sectors: Gate[] = []): CatalogTrack => ({
  id,
  country: 'BR',
  location: 'Test',
  track: { ...DEFAULT_TRACK, name: id, startFinish, sectors },
});

describe('track detection', () => {
  const ring = known('br/ring', radial(90), [radial(180), radial(270)]);
  const elsewhere = known('br/elsewhere', {
    a: { latitude: -30, longitude: -51 },
    b: { latitude: -30.0003, longitude: -51 },
  });

  it('finds the track the session drove on', () => {
    const matches = detectTracks([circle(100)], [elsewhere, ring]);
    expect(matches.map((m) => m.entry.id)).toEqual(['br/ring']);
    expect(matches[0]).toMatchObject({ crossings: 4, linesCrossed: 3, lines: 3 });
    expect(bestTrackMatch(matches)?.entry.id).toBe('br/ring');
  });

  it('finds nothing without GPS, far away or without crossing the start/finish line', () => {
    expect(detectTracks([], [ring])).toEqual([]);
    expect(detectTracks([circle(100)], [elsewhere])).toEqual([]);
    // Same place, but the line is outside the circle.
    expect(detectTracks([circle(100)], [known('br/outside', radial(90, 200))])).toEqual([]);
  });

  it('needs at least half of the lines', () => {
    // Driven only between 0° and 100°: crosses the start/finish (90°) but no sector line.
    const part = circle(100, 0, 100);
    expect(detectTracks([part], [ring])).toEqual([]);
    expect(detectTracks([part], [known('br/half', radial(90), [radial(180)])])).toHaveLength(1);
  });

  it('adds up several paths', () => {
    const [match] = detectTracks([circle(100), circle(60)], [ring]);
    expect(match?.crossings).toBe(6);
  });

  it('prefers the layout with more lines crossed, and does not pick between equal ones', () => {
    const twin = known('br/twin', radial(90), [radial(180), radial(270)]);
    const longer = known('br/longer', radial(90), [radial(180), radial(270), radial(0, 400)]);
    const matches = detectTracks([circle(100)], [longer, ring, twin]);
    expect(matches.map((m) => m.entry.id)).toEqual(['br/ring', 'br/twin', 'br/longer']);
    expect(bestTrackMatch(matches)).toBeNull();
    expect(bestTrackMatch(detectTracks([circle(100)], [longer, ring]))?.entry.id).toBe('br/ring');
    expect(bestTrackMatch([])).toBeNull();
  });

  it('finds the bounds and centre of the session', () => {
    expect(gpsBounds([])).toBeNull();
    const box = gpsBounds([circle(30, 0, 90), circle(30, 180, 270)]);
    const centre = boundsCentre(box as NonNullable<typeof box>);
    expect(centre.latitude).toBeCloseTo(LAT0, 4);
    expect(centre.longitude).toBeCloseTo(LON0, 4);
  });

  it('reads the GPS path of a telemetry series', () => {
    const { latitude, longitude } = circle(10);
    const channel = (key: string, samples: typeof latitude) => ({ key, label: key, unit: '°', ...samples });
    const series: TelemetrySeries = {
      kind: 'racechrono',
      name: 'test',
      startEpochMs: null,
      channels: [channel('latitude', latitude), channel('longitude', longitude)],
      metadata: {},
    };
    expect(seriesGpsPath(series)?.latitude.values).toBe(latitude.values);
    expect(seriesGpsPath({ ...series, channels: [] })).toBeNull();
  });
});
