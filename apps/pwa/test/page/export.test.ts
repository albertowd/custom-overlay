import { createProject, type ImageSequencePlan } from '@custom-overlay/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInEngine } from '../../src/engine';
import { exportImageSequence, folderTarget, type SequenceTarget, zipTarget } from '../../src/export';
import type { ExportWorkerRequest } from '../../src/export-protocol';
import { FakeWorker, installFakeWorker } from './fake-worker';
import { folderHandle, mockLinkClicks } from './helpers';

vi.mock('../../src/engine', () => ({ runInEngine: vi.fn() }));

const project = createProject({ name: 'Race' });
const plan = (frames: number): ImageSequencePlan => ({
  width: 64,
  height: 36,
  frameRate: 30,
  start: 12,
  frames,
});
const png = (n: number) => new Uint8Array([137, 80, 78, 71, n]);

/** Frame workers answer every request at once, or hold the frames listed in `held`. */
function autoAnswer(options: { warnings?: (frame: number) => string[]; held?: Set<number> } = {}) {
  const held = new Map<number, () => void>();
  const listen = () => {
    for (const worker of FakeWorker.instances) {
      worker.onPost ??= (message) => {
        const request = message as ExportWorkerRequest;
        if (request.type === 'init') return worker.reply({ type: 'ready' });
        const answer = () =>
          worker.reply({
            type: 'frame',
            frame: request.frame,
            png: png(request.frame),
            warnings: options.warnings?.(request.frame) ?? [],
          });
        if (options.held?.has(request.frame)) held.set(request.frame, answer);
        else answer();
      };
    }
  };
  // Workers are created by the export: wire each one as it appears.
  const original = FakeWorker.prototype.postMessage;
  vi.spyOn(FakeWorker.prototype, 'postMessage').mockImplementation(function (this: FakeWorker, message) {
    listen();
    original.call(this, message);
  });
  return { release: (frame: number) => held.get(frame)?.() };
}

function memoryTarget(): SequenceTarget & { files: [string, Uint8Array][]; finished: boolean } {
  const target = {
    name: 'memory',
    files: [] as [string, Uint8Array][],
    finished: false,
    write: async (fileName: string, data: Uint8Array) => {
      target.files.push([fileName, data]);
    },
    finish: async () => {
      target.finished = true;
    },
  };
  return target;
}

beforeEach(() => {
  installFakeWorker();
  vi.mocked(runInEngine).mockResolvedValue({ plan: plan(5), media: { videos: {}, series: {} } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('image sequence export', () => {
  it('draws on several workers and writes every frame in order', async () => {
    autoAnswer();
    const target = memoryTarget();
    const progress = vi.fn();
    const result = await exportImageSequence({
      project,
      target,
      signal: new AbortController().signal,
      onProgress: progress,
      workers: 2,
    });
    expect(runInEngine).toHaveBeenCalledWith('imageSequence', { project });
    expect(FakeWorker.instances).toHaveLength(2);
    const init = FakeWorker.instances[0]?.posted[0] as Extract<ExportWorkerRequest, { type: 'init' }>;
    expect(init.init).toMatchObject({
      width: 64,
      height: 36,
      frameRate: 30,
      start: 12,
      template: project.template,
    });
    expect(target.files.map(([name]) => name)).toEqual([
      'frame_000000.png',
      'frame_000001.png',
      'frame_000002.png',
      'frame_000003.png',
      'frame_000004.png',
    ]);
    expect(target.files[3]?.[1]).toEqual(png(3));
    expect(target.finished).toBe(true);
    // Frame n goes to worker n mod 2.
    const framesOf = (w: number) =>
      ((FakeWorker.instances[w]?.posted ?? []) as ExportWorkerRequest[]).flatMap((m) =>
        m.type === 'frame' ? [m.frame] : [],
      );
    expect(framesOf(0)).toEqual([0, 2, 4]);
    expect(framesOf(1)).toEqual([1, 3]);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ frame: 5, frames: 5 }));
    expect(result).toMatchObject({
      outputPath: 'memory',
      frames: 5,
      encoder: null,
      workers: 2,
      warnings: [],
    });
    expect(FakeWorker.instances.every((w) => w.terminated)).toBe(true);
  });

  it('keeps the order when a later frame is ready first', async () => {
    const answers = autoAnswer({ held: new Set([0]) });
    const target = memoryTarget();
    const done = exportImageSequence({
      project,
      target,
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      workers: 3,
    });
    await vi.waitFor(() => expect(FakeWorker.instances[0]?.posted).toHaveLength(3));
    expect(target.files).toEqual([]);
    answers.release(0);
    await done;
    expect(target.files.map(([name]) => name)).toEqual([0, 1, 2, 3, 4].map((n) => `frame_00000${n}.png`));
  });

  it('reports each widget error once', async () => {
    autoAnswer({ warnings: (frame) => (frame < 3 ? ['Speed: no speed value'] : []) });
    const result = await exportImageSequence({
      project,
      target: memoryTarget(),
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      workers: 1,
    });
    expect(result.warnings).toEqual(['Speed: no speed value']);
  });

  it('refuses an empty range before starting any worker', async () => {
    vi.mocked(runInEngine).mockResolvedValue({ plan: plan(0), media: { videos: {}, series: {} } });
    await expect(
      exportImageSequence({
        project,
        target: memoryTarget(),
        signal: new AbortController().signal,
        onProgress: vi.fn(),
      }),
    ).rejects.toThrow('The export range is empty');
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('stops when cancelled, without finishing the output', async () => {
    autoAnswer({ held: new Set([2]) });
    const target = memoryTarget();
    const controller = new AbortController();
    const done = exportImageSequence({
      project,
      target,
      signal: controller.signal,
      onProgress: vi.fn(),
      workers: 1,
    });
    await vi.waitFor(() => expect(target.files).toHaveLength(2));
    controller.abort();
    // The frame being waited for still arrives; nothing is written after it.
    (FakeWorker.instances[0] as FakeWorker).reply({ type: 'frame', frame: 2, png: png(2), warnings: [] });
    await expect(done).rejects.toThrow('Export cancelled');
    expect(target.files).toHaveLength(3);
    expect(target.finished).toBe(false);
    expect(FakeWorker.instances[0]?.terminated).toBe(true);
  });

  it('fails when a worker cannot be set up, and stops every worker', async () => {
    vi.spyOn(FakeWorker.prototype, 'postMessage').mockImplementation(function (this: FakeWorker) {
      this.reply({ type: 'error', message: 'No 2D canvas in this browser' });
    });
    await expect(
      exportImageSequence({
        project,
        target: memoryTarget(),
        signal: new AbortController().signal,
        onProgress: vi.fn(),
        workers: 2,
      }),
    ).rejects.toThrow('No 2D canvas in this browser');
    expect(FakeWorker.instances.every((w) => w.terminated)).toBe(true);
  });

  it('fails when a worker breaks while drawing', async () => {
    autoAnswer({ held: new Set([1]) });
    const target = memoryTarget();
    const done = exportImageSequence({
      project,
      target,
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      workers: 1,
    });
    await vi.waitFor(() => expect(target.files).toHaveLength(1));
    (FakeWorker.instances[0] as FakeWorker).fail('');
    await expect(done).rejects.toThrow('Export worker failed');
    expect(target.finished).toBe(false);
  });

  it('uses half the cores for drawing, from one to six workers', async () => {
    autoAnswer();
    const run = async (cores: number) => {
      FakeWorker.instances = [];
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(cores);
      return (
        await exportImageSequence({
          project,
          target: memoryTarget(),
          signal: new AbortController().signal,
          onProgress: vi.fn(),
        })
      ).workers;
    };
    expect(await run(16)).toBe(6);
    expect(await run(8)).toBe(4);
    expect(await run(1)).toBe(1);
  });
});

describe('sequence targets', () => {
  it('writes PNG files into the picked folder', async () => {
    const folder = folderHandle('Race frames');
    const target = folderTarget(folder);
    expect(target.name).toBe('Race frames');
    await target.write('frame_000000.png', png(0));
    await target.finish();
    expect(folder.files.get('frame_000000.png')?.written).toEqual([png(0)]);
  });

  it('downloads one zip named after the project', async () => {
    const clicks = mockLinkClicks();
    const target = zipTarget(project);
    expect(target.name).toBe('Race frames.zip');
    await target.write('frame_000000.png', png(0));
    await target.write('frame_000001.png', png(1));
    expect(clicks).toHaveLength(0);
    await target.finish();
    expect(clicks.map((link) => link.download)).toEqual(['Race frames.zip']);
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe('application/zip');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    // End of central directory: two files.
    expect(view.getUint32(bytes.byteLength - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(bytes.byteLength - 12, true)).toBe(2);
    expect(new TextDecoder().decode(bytes)).toContain('frame_000001.png');
  });
});
