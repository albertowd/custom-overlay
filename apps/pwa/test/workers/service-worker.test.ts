import { runInNewContext } from 'node:vm';
import type { Rollup } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { serviceWorker } from '../../vite.config';

const ORIGIN = 'https://app.test';
const absolute = (url: string) => new URL(url, `${ORIGIN}/`).href;

/** The `sw.js` the build plugin emits for `bundle`. */
function emit(
  bundle: Record<string, { type: 'chunk'; code: string } | { type: 'asset'; source: string }>,
): string {
  const emitted: { fileName: string; source: string }[] = [];
  const hook = serviceWorker().generateBundle as (
    this: unknown,
    options: unknown,
    bundle: Rollup.OutputBundle,
  ) => void;
  hook.call(
    { emitFile: (file: { fileName: string; source: string }) => emitted.push(file) },
    {},
    bundle as never,
  );
  expect(emitted.map((f) => f.fileName)).toEqual(['sw.js']);
  return emitted[0]?.source ?? '';
}

const BUNDLE = {
  'assets/index-a1.js': { type: 'chunk' as const, code: 'console.log(1)' },
  'assets/index-a1.js.map': { type: 'asset' as const, source: '{}' },
  'assets/engine.worker-b2.js': { type: 'chunk' as const, code: 'postMessage(1)' },
  'index.html': { type: 'asset' as const, source: '<html></html>' },
};

const constant = (source: string, name: string) =>
  JSON.parse(new RegExp(`const ${name} = (.*);`).exec(source)?.[1] ?? 'null') as unknown;

class FakeCache {
  readonly entries = new Map<string, Response>();

  async addAll(urls: string[]) {
    for (const url of urls) this.entries.set(absolute(url), new Response(`cached ${url}`));
  }

  async match(request: string | { url: string }) {
    return this.entries.get(absolute(typeof request === 'string' ? request : request.url));
  }
}

class FakeCaches {
  readonly stores = new Map<string, FakeCache>();

  async open(name: string) {
    let cache = this.stores.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.stores.set(name, cache);
    }
    return cache;
  }

  async keys() {
    return [...this.stores.keys()];
  }

  async delete(name: string) {
    return this.stores.delete(name);
  }
}

/** Run `sw.js` with fake caches and network; returns how to send it events. */
function startWorker(source: string) {
  const listeners = new Map<string, (event: unknown) => void>();
  const caches = new FakeCaches();
  const fetch = vi.fn(async (request: { url: string }) => new Response(`network ${request.url}`));
  runInNewContext(source, {
    self: {
      addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
      location: { origin: ORIGIN },
    },
    caches,
    fetch,
    URL,
  });
  /** Dispatch a lifecycle event and wait for what it waits for. */
  const lifecycle = async (type: 'install' | 'activate') => {
    let pending: Promise<unknown> = Promise.resolve();
    listeners.get(type)?.({ waitUntil: (promise: Promise<unknown>) => (pending = promise) });
    await pending;
  };
  /** A request: the response the worker gives, or null when it lets the browser handle it. */
  const request = async (url: string, init: { method?: string; mode?: string } = {}) => {
    let response = null as Promise<Response> | null;
    listeners.get('fetch')?.({
      request: { url: absolute(url), method: init.method ?? 'GET', mode: init.mode ?? 'cors' },
      respondWith: (r: Promise<Response>) => (response = r),
    });
    return response ? (await response).text() : null;
  };
  return { caches, fetch, lifecycle, request };
}

describe('service worker build', () => {
  it('lists every file of the build and the public folder, without source maps', () => {
    const source = emit(BUNDLE);
    expect(constant(source, 'PRECACHE')).toEqual([
      './',
      'assets/engine.worker-b2.js',
      'assets/index-a1.js',
      'icons/favicon.svg',
      'icons/icon-192.png',
      'icons/icon-512.png',
      'index.html',
      'manifest.webmanifest',
    ]);
    expect(source).not.toMatch(/__VERSION__|__PRECACHE__/);
  });

  it('versions the worker by the content of the build', () => {
    const version = constant(emit(BUNDLE), 'VERSION');
    expect(version).toMatch(/^[0-9a-f]{16}$/);
    expect(constant(emit(BUNDLE), 'VERSION')).toBe(version);
    const changed = { ...BUNDLE, 'assets/index-a1.js': { type: 'chunk' as const, code: 'console.log(2)' } };
    expect(constant(emit(changed), 'VERSION')).not.toBe(version);
  });
});

describe('service worker', () => {
  const source = emit(BUNDLE);
  const cacheName = `custom-overlay-${constant(source, 'VERSION')}`;

  it('precaches the app when installed', async () => {
    const worker = startWorker(source);
    await worker.lifecycle('install');
    expect([...worker.caches.stores.keys()]).toEqual([cacheName]);
    expect(worker.caches.stores.get(cacheName)?.entries.size).toBe(8);
  });

  it('removes the caches of earlier versions only, once active', async () => {
    const worker = startWorker(source);
    await worker.caches.open('custom-overlay-old');
    await worker.caches.open('someone-else');
    await worker.lifecycle('install');
    await worker.lifecycle('activate');
    expect([...worker.caches.stores.keys()].sort()).toEqual([cacheName, 'someone-else'].sort());
  });

  it('serves the app from the cache, offline included', async () => {
    const worker = startWorker(source);
    await worker.lifecycle('install');
    // Any page of the app is the app shell.
    expect(await worker.request('/projects/race', { mode: 'navigate' })).toBe('cached ./');
    expect(await worker.request('/assets/index-a1.js')).toBe('cached assets/index-a1.js');
    expect(worker.fetch).not.toHaveBeenCalled();
    // Files the build did not list come from the network.
    expect(await worker.request('/favicon.ico')).toBe(`network ${ORIGIN}/favicon.ico`);
  });

  it('leaves other sites and other methods to the browser', async () => {
    const worker = startWorker(source);
    await worker.lifecycle('install');
    expect(await worker.request('https://raw.githubusercontent.com/catalog.json')).toBeNull();
    expect(await worker.request('/api', { method: 'POST' })).toBeNull();
  });

  it('never takes over a running page: a new version waits for every tab to close', () => {
    expect(source).not.toContain('skipWaiting');
    expect(source).not.toContain('clients.claim');
  });
});
