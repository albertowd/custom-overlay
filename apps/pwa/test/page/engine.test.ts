import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineRequest } from '../../src/engine-protocol';
import { FakeWorker, installFakeWorker } from './fake-worker';

let runInEngine: typeof import('../../src/engine').runInEngine;
let worker: FakeWorker;

beforeEach(async () => {
  installFakeWorker();
  vi.resetModules();
  ({ runInEngine } = await import('../../src/engine'));
  worker = FakeWorker.instances[0] as FakeWorker;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const lastRequest = () => worker.posted.at(-1) as EngineRequest;

describe('engine client', () => {
  it('starts one module worker for the engine', () => {
    expect(FakeWorker.instances).toHaveLength(1);
    expect(String(worker.url)).toContain('engine.worker.ts');
    expect(worker.options).toEqual({ type: 'module' });
  });

  it('runs operations in the worker and resolves with their result', async () => {
    const project = { name: 'p' } as never;
    const first = runInEngine('evaluateValues', { project, frameRate: 30 });
    const second = runInEngine('imageSequence', { project });
    const [a, b] = worker.posted as EngineRequest[];
    expect(a).toEqual({ id: 0, operation: 'evaluateValues', args: { project, frameRate: 30 } });
    expect(b?.id).toBe(1);
    // Answers may come in any order.
    worker.reply({ id: 1, ok: true, result: 'plan' });
    worker.reply({ id: 0, ok: true, result: 'snapshot' });
    expect(await first).toBe('snapshot');
    expect(await second).toBe('plan');
  });

  it('rejects with the error of the operation', async () => {
    const run = runInEngine('loadSource', {
      path: 'x.csv',
      kind: 'racechrono',
      file: new File([], 'x.csv'),
      subtitles: null,
    });
    worker.reply({ id: lastRequest().id, ok: false, message: "'x.csv' is not a RaceChrono export" });
    await expect(run).rejects.toThrow("'x.csv' is not a RaceChrono export");
  });

  it('ignores answers to nothing asked', async () => {
    const run = runInEngine('imageSequence', { project: {} as never });
    worker.reply({ id: 99, ok: true, result: 'stray' });
    worker.reply({ id: lastRequest().id, ok: true, result: 'mine' });
    expect(await run).toBe('mine');
  });

  it('fails everything in flight when the worker fails', async () => {
    const a = runInEngine('imageSequence', { project: {} as never });
    const b = runInEngine('imageSequence', { project: {} as never });
    worker.fail('SyntaxError in engine.worker.ts');
    await expect(a).rejects.toThrow('SyntaxError in engine.worker.ts');
    await expect(b).rejects.toThrow('SyntaxError in engine.worker.ts');
    // A later failure without a message still explains itself.
    const c = runInEngine('imageSequence', { project: {} as never });
    worker.fail('');
    await expect(c).rejects.toThrow('Engine worker failed');
  });
});
