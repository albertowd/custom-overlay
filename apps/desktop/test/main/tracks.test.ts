import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRACK_CATALOG_URL } from '@custom-overlay/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, paths } from './electron-mock';

vi.mock('electron', () => import('./electron-mock'));

const catalog = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../../packages/core/src/tracks/catalog.json'), 'utf8'),
) as { tracks: { id: string }[] };
const ids = catalog.tracks.map((t) => t.id);

const fetchMock = vi.fn<typeof fetch>();
let userData: string;

const cacheFile = () => join(userData, 'tracks', 'catalog.json');
const cached = () => JSON.parse(readFileSync(cacheFile(), 'utf8'));

function writeCache(entry: unknown): void {
  mkdirSync(join(userData, 'tracks'), { recursive: true });
  writeFileSync(cacheFile(), JSON.stringify(entry));
}

/** A fresh module: it keeps the download of the run. */
const load = async () => {
  vi.resetModules();
  return (await import('../../src/main/tracks')).remoteTrackCatalog;
};

const respond = (body: string | null, init: ResponseInit = {}) =>
  fetchMock.mockResolvedValueOnce(new Response(body, init));

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'co-tracks-'));
  paths.userData = userData;
  app.isPackaged = true;
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('remoteTrackCatalog', () => {
  it('downloads the catalog, caches it with its ETag and reuses the download', async () => {
    respond(JSON.stringify(catalog), { headers: { etag: '"abc"' } });
    const remoteTrackCatalog = await load();
    const result = await remoteTrackCatalog();
    expect(result?.source).toBe('github');
    expect(result?.tracks.map((t) => t.id)).toEqual(ids);
    expect(cached()).toMatchObject({ etag: '"abc"', catalog, fetchedAt: result?.fetchedAt });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(TRACK_CATALOG_URL);

    expect(await remoteTrackCatalog()).toBe(result);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks only for changes and keeps the cached catalog when GitHub has nothing new', async () => {
    writeCache({ etag: '"abc"', fetchedAt: '2026-01-01T00:00:00.000Z', catalog });
    respond(null, { status: 304 });
    const result = await (await load())();
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['If-None-Match']).toBe('"abc"');
    expect(result?.source).toBe('github');
    expect(result?.tracks).toHaveLength(ids.length);
    expect(result?.fetchedAt).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('falls back to the last download offline, and retries on the next call', async () => {
    writeCache({ etag: null, fetchedAt: '2026-01-01T00:00:00.000Z', catalog });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const remoteTrackCatalog = await load();
    expect(await remoteTrackCatalog()).toMatchObject({
      source: 'cache',
      fetchedAt: '2026-01-01T00:00:00.000Z',
    });
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['If-None-Match']).toBeUndefined();

    respond(JSON.stringify(catalog));
    expect((await remoteTrackCatalog())?.source).toBe('github');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an error status', () => respond('nope', { status: 500 })],
    ['a file that is not a catalog', () => respond(JSON.stringify({ hello: 'world' }))],
    ['a file that is not JSON', () => respond('<html>')],
    ['a file too large', () => respond(' '.repeat(20 * 1024 * 1024 + 1))],
  ])('keeps the cached catalog on %s', async (_name, answer) => {
    writeCache({ etag: null, fetchedAt: '2026-01-01T00:00:00.000Z', catalog });
    answer();
    expect((await (await load())())?.source).toBe('cache');
    expect(cached().fetchedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns null without a download, and retries on the next call', async () => {
    respond('nope', { status: 503 });
    const remoteTrackCatalog = await load();
    expect(await remoteTrackCatalog()).toBeNull();
    respond(JSON.stringify(catalog));
    expect(await remoteTrackCatalog()).not.toBeNull();
  });

  it('returns null when the cached file is broken', async () => {
    writeCache({ etag: null, fetchedAt: '2026-01-01T00:00:00.000Z', catalog: { tracks: 'no' } });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await (await load())()).toBeNull();
  });

  it('lets development builds use another catalog', async () => {
    vi.stubEnv('CUSTOM_OVERLAY_TRACKS_URL', 'http://localhost:8080/catalog.json');
    respond(JSON.stringify(catalog));
    await (await load())();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(TRACK_CATALOG_URL);

    app.isPackaged = false;
    respond(JSON.stringify(catalog));
    await (await load())();
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://localhost:8080/catalog.json');
  });
});
