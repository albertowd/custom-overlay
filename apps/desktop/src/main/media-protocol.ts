import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { protocol } from 'electron';

/**
 * `media://` serves local video files to the renderer with HTTP range support (needed to seek).
 * Only files explicitly registered by the main process (picked by the user) are served.
 */
const SCHEME = 'media';
const registered = new Map<string, string>();
const tokensByPath = new Map<string, string>();

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
};

/** Must be called before the app is ready. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
  ]);
}

/** Allow a file to be served and return its URL. */
export function mediaUrlFor(path: string): string {
  const absolute = resolve(path);
  let token = tokensByPath.get(absolute);
  if (!token) {
    token = randomUUID();
    tokensByPath.set(absolute, token);
    registered.set(token, absolute);
  }
  return `${SCHEME}://file/${token}`;
}

function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startText = '', endText = ''] = match;
  if (startText === '' && endText === '') return null;
  let start: number;
  let end: number;
  if (startText === '') {
    // suffix range: last N bytes
    start = Math.max(0, size - Number(endText));
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText === '' ? size - 1 : Math.min(Number(endText), size - 1);
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

function streamBody(path: string, start: number, end: number): ReadableStream {
  return Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
}

export function handleMediaProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    const token = new URL(request.url).pathname.replace(/^\//, '');
    const path = registered.get(token);
    if (!path) return new Response('Not found', { status: 404 });

    const { size } = await stat(path);
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Content-Type': MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
    });
    const rangeHeader = request.headers.get('Range');
    if (!rangeHeader) {
      headers.set('Content-Length', String(size));
      return new Response(streamBody(path, 0, size - 1), { status: 200, headers });
    }
    const range = parseRange(rangeHeader, size);
    if (!range) {
      headers.set('Content-Range', `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set('Content-Length', String(range.end - range.start + 1));
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    return new Response(streamBody(path, range.start, range.end), { status: 206, headers });
  });
}
