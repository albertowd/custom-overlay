import { createProject } from '@custom-overlay/core';
import type { ExportOptions, ExportResult } from '@custom-overlay/core/node';
import type { WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcChannel } from '../../src/shared/ipc';
import { FakeWebContents } from './electron-mock';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('../../src/main/export-worker?modulePath', () => ({ default: '/out/main/export-worker.js' }));
vi.mock('node:worker_threads', () => ({
  Worker: vi.fn(function Worker(this: { path: string }, path: string) {
    this.path = path;
  }),
}));
vi.mock('@custom-overlay/core/node', () => ({ exportProject: vi.fn() }));

const { exportProject } = await import('@custom-overlay/core/node');
const { Worker } = await import('node:worker_threads');
const { cancelExport, exportRunning, startExport } = await import('../../src/main/export');
const { rememberVideo } = await import('@custom-overlay/ui/host');

const exportMock = vi.mocked(exportProject);
const RESULT = {
  frames: 10,
  outputPath: '/out.mp4',
  seconds: 1,
  encoder: null,
  warnings: [],
} as unknown as ExportResult;

/** An export that waits until the test settles it. */
function pendingExport() {
  let options: ExportOptions | undefined;
  let finish: (result: ExportResult) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  exportMock.mockImplementationOnce((opts) => {
    options = opts;
    return new Promise<ExportResult>((resolve, reject) => {
      finish = resolve;
      fail = reject;
      opts.signal?.addEventListener('abort', () => reject(new Error('cancelled')));
    });
  });
  return {
    options: () => options as ExportOptions,
    finish: (result: ExportResult) => finish(result),
    fail: (error: Error) => fail(error),
  };
}

const sender = () => new FakeWebContents() as unknown as WebContents & InstanceType<typeof FakeWebContents>;

beforeEach(() => {
  exportMock.mockReset();
});

describe('startExport', () => {
  it('exports the project with the loaded media, a worker factory and progress to the window', async () => {
    const run = pendingExport();
    const window = sender();
    const project = createProject();
    rememberVideo('/a.mp4', { path: '/a.mp4' } as never, null);
    const exporting = startExport(window, project);
    expect(exportRunning()).toBe(true);

    const options = run.options();
    expect(options.project).toBe(project);
    expect(options.media).toEqual({ videos: {}, series: {} });
    const worker = options.createWorker?.() as unknown as { path: string };
    expect(Worker).toHaveBeenCalledWith('/out/main/export-worker.js');
    expect(worker.path).toBe('/out/main/export-worker.js');

    const progress = { frame: 1, frames: 10 } as never;
    options.onProgress?.(progress);
    expect(window.send).toHaveBeenCalledWith(IpcChannel.exportProgress, progress);
    window.destroyed = true;
    options.onProgress?.(progress);
    expect(window.send).toHaveBeenCalledTimes(1);

    run.finish(RESULT);
    expect(await exporting).toBe(RESULT);
    expect(exportRunning()).toBe(false);
  });

  it('runs one export at a time', async () => {
    const run = pendingExport();
    const first = startExport(sender(), createProject());
    await expect(startExport(sender(), createProject())).rejects.toThrow('An export is already running');
    run.finish(RESULT);
    await first;
  });

  it('can be cancelled, and is done after a failure', async () => {
    pendingExport();
    const exporting = startExport(sender(), createProject());
    cancelExport();
    await expect(exporting).rejects.toThrow('cancelled');
    expect(exportRunning()).toBe(false);

    const run = pendingExport();
    const failing = startExport(sender(), createProject());
    run.fail(new Error('ffmpeg crashed'));
    await expect(failing).rejects.toThrow('ffmpeg crashed');
    expect(exportRunning()).toBe(false);
  });

  it('ignores a cancel without an export', () => {
    expect(() => cancelExport()).not.toThrow();
  });
});

describe('export worker entry', () => {
  it('starts the core export worker', async () => {
    const runExportWorker = vi.fn();
    vi.doMock('@custom-overlay/core/node', () => ({ runExportWorker }));
    await import('../../src/main/export-worker');
    expect(runExportWorker).toHaveBeenCalledOnce();
  });
});
