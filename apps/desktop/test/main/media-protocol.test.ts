import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { handleMediaProtocol, mediaUrlFor, registerMediaScheme } from '../../src/main/media-protocol';
import { protocol } from './electron-mock';

vi.mock('electron', () => import('./electron-mock'));

const CONTENT = '0123456789abcdefghij';
let folder: string;
let video: string;
let serve: (request: Request) => Promise<Response>;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'co-media-'));
  video = join(folder, 'clip.MOV');
  writeFileSync(video, CONTENT);
  writeFileSync(join(folder, 'other.bin'), CONTENT);
  handleMediaProtocol();
  const [scheme, handler] = protocol.handle.mock.calls[0] ?? [];
  expect(scheme).toBe('media');
  serve = handler as typeof serve;
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

const get = (url: string, range?: string) =>
  serve(new Request(url, { headers: range === undefined ? {} : { Range: range } }));

describe('media protocol', () => {
  it('registers a privileged streaming scheme', () => {
    registerMediaScheme();
    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      expect.objectContaining({ scheme: 'media', privileges: expect.objectContaining({ stream: true }) }),
    ]);
    expect(serve).toBeTypeOf('function');
  });

  it('gives a file one URL, different from other files', () => {
    const url = mediaUrlFor(video);
    expect(url).toMatch(/^media:\/\/file\/[0-9a-f-]{36}$/);
    expect(mediaUrlFor(join(folder, '.', 'clip.MOV'))).toBe(url);
    expect(mediaUrlFor(join(folder, 'other.bin'))).not.toBe(url);
  });

  it('serves the whole file with its type', async () => {
    const response = await get(mediaUrlFor(video));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('video/quicktime');
    expect(response.headers.get('Content-Length')).toBe(String(CONTENT.length));
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(await response.text()).toBe(CONTENT);
  });

  it('serves unknown extensions as bytes', async () => {
    const response = await get(mediaUrlFor(join(folder, 'other.bin')));
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
  });

  it.each([
    ['bytes=2-5', 2, 5],
    ['bytes=15-', 15, 19],
    ['bytes=-4', 16, 19],
    ['bytes=-100', 0, 19],
    ['bytes=10-999', 10, 19],
    [' bytes=0-0 ', 0, 0],
  ])('serves the range %s', async (range, start, end) => {
    const response = await get(mediaUrlFor(video), range);
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe(`bytes ${start}-${end}/${CONTENT.length}`);
    expect(response.headers.get('Content-Length')).toBe(String(end - start + 1));
    expect(await response.text()).toBe(CONTENT.slice(start, end + 1));
  });

  it.each(['bytes=-', 'bytes=5-2', 'bytes=20-', 'items=0-1', 'bytes=0-1,4-5'])(
    'refuses the range %s',
    async (range) => {
      const response = await get(mediaUrlFor(video), range);
      expect(response.status).toBe(416);
      expect(response.headers.get('Content-Range')).toBe(`bytes */${CONTENT.length}`);
    },
  );

  it('serves only files registered by the main process', async () => {
    const response = await get('media://file/not-a-token');
    expect(response.status).toBe(404);
  });
});
