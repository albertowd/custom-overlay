import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseTrackCatalog, TRACK_CATALOG_URL } from '@custom-overlay/core';
import type { RemoteTrackCatalog } from '@custom-overlay/ui/api';
import { app } from 'electron';

/** The last catalog downloaded, for offline starts: the file and its ETag. */
interface CachedCatalog {
  etag: string | null;
  fetchedAt: string;
  catalog: unknown;
}

/** A catalog this large is not ours: refuse it. */
const MAX_BYTES = 20 * 1024 * 1024;

const cacheFile = () => join(app.getPath('userData'), 'tracks', 'catalog.json');

/** Development builds can test another catalog (a fork, a local server) with CUSTOM_OVERLAY_TRACKS_URL. */
const catalogUrl = () => (!app.isPackaged && process.env.CUSTOM_OVERLAY_TRACKS_URL) || TRACK_CATALOG_URL;

async function readCache(): Promise<CachedCatalog | null> {
  try {
    return JSON.parse(await readFile(cacheFile(), 'utf8')) as CachedCatalog;
  } catch {
    return null;
  }
}

async function download(cached: CachedCatalog | null): Promise<RemoteTrackCatalog | null> {
  const headers: Record<string, string> = { 'User-Agent': `custom-overlay/${app.getVersion()}` };
  if (cached?.etag) headers['If-None-Match'] = cached.etag;
  const response = await fetch(catalogUrl(), { headers, signal: AbortSignal.timeout(10_000) });
  if (response.status === 304 && cached) {
    return {
      tracks: parseTrackCatalog(cached.catalog),
      source: 'github',
      fetchedAt: new Date().toISOString(),
    };
  }
  if (!response.ok) return null;
  const text = await response.text();
  if (text.length > MAX_BYTES) return null;
  const catalog: unknown = JSON.parse(text);
  // Throws when it is not a catalog: the cache keeps the last good one.
  const tracks = parseTrackCatalog(catalog);
  const fetchedAt = new Date().toISOString();
  const entry: CachedCatalog = { etag: response.headers.get('etag'), fetchedAt, catalog };
  await mkdir(dirname(cacheFile()), { recursive: true });
  await writeFile(cacheFile(), JSON.stringify(entry));
  return { tracks, source: 'github', fetchedAt };
}

async function load(): Promise<RemoteTrackCatalog | null> {
  const cached = await readCache();
  try {
    const fresh = await download(cached);
    if (fresh) return fresh;
  } catch {
    // Offline, GitHub unreachable or a broken file: fall back to the last download.
  }
  if (!cached) return null;
  try {
    return { tracks: parseTrackCatalog(cached.catalog), source: 'cache', fetchedAt: cached.fetchedAt };
  } catch {
    return null;
  }
}

let pending: Promise<RemoteTrackCatalog | null> | null = null;

/**
 * The latest track list from the repository (null offline without an earlier download). Only the
 * list is downloaded, never the session's positions: nearby tracks are found on this computer.
 * Downloaded once per run; a failed attempt is retried on the next call.
 */
export function remoteTrackCatalog(): Promise<RemoteTrackCatalog | null> {
  pending ??= load().then((result) => {
    if (!result || result.source === 'cache') pending = null;
    return result;
  });
  return pending;
}
