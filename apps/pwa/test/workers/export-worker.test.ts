import { createProject, createWidget, type FrameRendererInit } from '@custom-overlay/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportWorkerRequest, ExportWorkerResponse } from '../../src/export-protocol';
import { workerScope } from './worker-scope';

/** A 2D context that accepts every call (measureText: 10 px per character). */
function fakeContext(): CanvasRenderingContext2D {
  const state: Record<string | symbol, unknown> = { globalAlpha: 1 };
  return new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'measureText') return (text: string) => ({ width: String(text).length * 10 });
      if (key === 'createLinearGradient' || key === 'createRadialGradient' || key === 'createPattern') {
        return () => ({ addColorStop: () => undefined });
      }
      return () => undefined;
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

/** OffscreenCanvas stand-in: its PNG is the 4 PNG signature bytes and the encode count. */
class FakeOffscreenCanvas {
  static instances: FakeOffscreenCanvas[] = [];
  static noContext = false;
  readonly ctx = fakeContext();
  encoded = 0;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    FakeOffscreenCanvas.instances.push(this);
  }

  getContext(type: string) {
    return type === '2d' && !FakeOffscreenCanvas.noContext ? this.ctx : null;
  }

  async convertToBlob(options: { type: string }) {
    expect(options.type).toBe('image/png');
    return new Blob([new Uint8Array([137, 80, 78, 71, ++this.encoded])]);
  }
}

const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';
const createImageBitmap = vi.fn(async (_blob: Blob) => ({ width: 1, height: 1 }));

function init(widgets = [createWidget('text', { name: 'Title' })]): FrameRendererInit {
  const project = createProject({ name: 'Race' });
  const template = { ...project.template, widgets };
  return {
    project: { ...project, template },
    media: { videos: {}, series: {} },
    template,
    palette: project.palette,
    width: 320,
    height: 180,
    frameRate: 30,
    start: 0,
  };
}

let scope: ReturnType<typeof workerScope<ExportWorkerRequest, ExportWorkerResponse>>;

/** Post `request`; resolves with the worker's next answer. */
function ask(request: ExportWorkerRequest): Promise<ExportWorkerResponse> {
  const answer = scope.next();
  scope.post(request);
  return answer;
}

beforeAll(async () => {
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  vi.stubGlobal('createImageBitmap', createImageBitmap);
  scope = workerScope<ExportWorkerRequest, ExportWorkerResponse>();
  await import('../../src/export.worker');
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  FakeOffscreenCanvas.noContext = false;
});

describe('export worker', () => {
  it('needs to be set up before drawing', async () => {
    expect(await ask({ type: 'frame', frame: 0 })).toEqual({
      type: 'error',
      message: 'The export worker is not set up',
    });
  });

  it('draws frames on an OffscreenCanvas of the output size and answers PNG files', async () => {
    expect(await ask({ type: 'init', init: init() })).toEqual({ type: 'ready' });
    const canvas = FakeOffscreenCanvas.instances.at(-1);
    expect([canvas?.width, canvas?.height]).toEqual([320, 180]);
    const answer = await ask({ type: 'frame', frame: 0 });
    expect(answer).toEqual({
      type: 'frame',
      frame: 0,
      png: new Uint8Array([137, 80, 78, 71, 1]),
      warnings: [],
    });
    // The PNG's buffer is moved to the page, not copied.
    const last = scope.answers.at(-1);
    expect(last?.transfer).toEqual([(answer as Extract<ExportWorkerResponse, { type: 'frame' }>).png.buffer]);
  });

  it('draws one frame at a time, in the order asked', async () => {
    await ask({ type: 'init', init: init() });
    const before = scope.answers.length;
    const done = new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (scope.answers.length >= before + 3) {
          clearInterval(check);
          resolve();
        }
      }, 1);
    });
    scope.post({ type: 'frame', frame: 5 });
    scope.post({ type: 'frame', frame: 3 });
    scope.post({ type: 'frame', frame: 4 });
    await done;
    const frames = scope.answers
      .slice(before)
      .map(({ data }) => (data.type === 'frame' ? [data.frame, data.png[4]] : null));
    expect(frames).toEqual([
      [5, 1],
      [3, 2],
      [4, 3],
    ]);
  });

  it('decodes the images of the widgets once, when set up', async () => {
    createImageBitmap.mockClear();
    const image = createWidget('image', { name: 'Car' });
    await ask({
      type: 'init',
      init: init(
        [image, { ...image, id: 'other' }].map((w) => ({ ...w, props: { ...w.props, src: IMAGE } })),
      ),
    });
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    const blob = createImageBitmap.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(await (blob as Blob).arrayBuffer()).toEqual(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer,
    );
  });

  it('explains a browser without 2D canvases', async () => {
    FakeOffscreenCanvas.noContext = true;
    expect(await ask({ type: 'init', init: init() })).toEqual({
      type: 'error',
      message: 'No 2D canvas in this browser',
    });
  });
});
