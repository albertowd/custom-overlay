import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BUSY_LATENCY_FLOOR_MS,
  copyAndRemove,
  DiskGuard,
  type DiskGuardOptions,
  moveFile,
} from '../src/node/disk-guard.js';

/** A guard on a fake clock: sleeping moves the clock, probes answer `latency`, timers run by hand. */
function fakeGuard(options: Partial<DiskGuardOptions> = {}) {
  const state = { clock: 0, latency: 10, slept: [] as number[], flushed: 0 };
  const timers: (() => void)[] = [];
  const guard = new DiskGuard({
    slow: true,
    maxSpeed: 0,
    frameRate: 10,
    outputPath: '/out.mp4',
    probePaths: ['/a.mp4'],
    now: () => state.clock,
    sleep: async (ms) => {
      state.slept.push(ms);
      state.clock += ms;
    },
    probe: async () => state.latency,
    flush: async () => {
      state.flushed++;
      return true;
    },
    every: (_ms, run) => {
      timers.push(run);
      return () => timers.splice(timers.indexOf(run), 1);
    },
    ...options,
  });
  /** Run every timer once and let their promises settle. */
  const tick = async () => {
    for (const run of [...timers]) run();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { guard, state, timers, tick };
}

describe('disk guard', () => {
  it('does nothing without slow disk mode or a speed limit', async () => {
    const { guard, state, timers } = fakeGuard({ slow: false });
    expect(guard.active).toBe(false);
    await guard.start();
    await guard.pace(0);
    expect(state.slept).toEqual([]);
    expect(timers).toHaveLength(0);
  });

  it('keeps the frames to the speed limit', async () => {
    const { guard, state } = fakeGuard({ slow: false, maxSpeed: 2 });
    expect(guard.active).toBe(true);
    await guard.start();
    // 10 fps at 2x: a frame every 50 ms.
    await guard.pace(0);
    expect(state.clock).toBe(50);
    state.clock += 200;
    await guard.pace(1);
    expect(state.slept).toEqual([50]);
  });

  it('slows the frames down while the disk is busy, and speeds up once it recovers', async () => {
    const { guard, state, tick } = fakeGuard();
    await guard.start();
    await guard.pace(0);
    expect(guard.status()).toEqual({ throttled: false, latencyMs: Number.NaN });
    state.latency = BUSY_LATENCY_FLOOR_MS + 50;
    await tick();
    await guard.pace(1);
    await guard.pace(2);
    expect(state.slept).toEqual([10, 15]);
    expect(guard.status()).toMatchObject({ throttled: true, latencyMs: BUSY_LATENCY_FLOOR_MS + 50 });
    state.latency = 5;
    for (let i = 0; i < 5; i++) await tick();
    for (let i = 3; i < 30; i++) await guard.pace(i);
    expect(guard.status().throttled).toBe(false);
  });

  it('waits for a stalled disk to answer again, for a while at most', async () => {
    const { guard, state, tick } = fakeGuard();
    await guard.start();
    state.latency = BUSY_LATENCY_FLOOR_MS * 10;
    await tick();
    await guard.pace(0);
    // Never recovers: 10 s of waiting, then the frame goes anyway (slowed down).
    expect(state.clock).toBeGreaterThanOrEqual(10_000);
    expect(guard.status().throttled).toBe(true);
  });

  it('counts a probe still waiting as latency', async () => {
    let answer: (ms: number) => void = () => undefined;
    const { guard, state, tick } = fakeGuard({
      probe: () => new Promise<number>((resolve) => (answer = resolve)),
    });
    const starting = guard.start();
    answer(8);
    await new Promise((resolve) => setImmediate(resolve));
    answer(8);
    await new Promise((resolve) => setImmediate(resolve));
    answer(8);
    await starting;
    await tick();
    state.clock += 1000;
    expect(guard.status().latencyMs).toBe(1000);
  });

  it('flushes the output regularly and once more when closing', async () => {
    const { guard, state, timers, tick } = fakeGuard();
    await guard.start();
    expect(timers).toHaveLength(2);
    await tick();
    expect(state.flushed).toBe(1);
    await guard.close();
    expect(state.flushed).toBe(2);
    expect(timers).toHaveLength(0);
    await guard.close();
    expect(state.flushed).toBe(2);
  });

  it('measures and flushes real files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'custom-overlay-disk-'));
    try {
      const video = join(dir, 'video.bin');
      await writeFile(video, Buffer.alloc(64 * 1024, 1));
      const guard = new DiskGuard({
        slow: true,
        maxSpeed: 0,
        frameRate: 30,
        outputPath: join(dir, 'missing.mp4'),
        probePaths: [video, join(dir, 'missing.bin')],
      });
      await guard.start();
      await guard.pace(0);
      await guard.close();
      expect(Number.isNaN(guard.status().latencyMs) || guard.status().latencyMs >= 0).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('moving the staged video', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'custom-overlay-move-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('renames on the same disk', async () => {
    await writeFile(join(dir, 'a.mp4'), 'video');
    await moveFile(join(dir, 'a.mp4'), join(dir, 'b.mp4'));
    expect(await readFile(join(dir, 'b.mp4'), 'utf8')).toBe('video');
    await expect(stat(join(dir, 'a.mp4'))).rejects.toThrow();
    await expect(moveFile(join(dir, 'nope.mp4'), join(dir, 'c.mp4'))).rejects.toThrow();
  });

  it('copies in chunks and removes the source', async () => {
    const data = Buffer.alloc(9 * 1024 * 1024, 7);
    await writeFile(join(dir, 'big.mp4'), data);
    const seen: number[] = [];
    await copyAndRemove(join(dir, 'big.mp4'), join(dir, 'copy.mp4'), {
      slow: true,
      onProgress: (done) => seen.push(done),
    });
    expect((await readFile(join(dir, 'copy.mp4'))).equals(data)).toBe(true);
    expect(seen).toEqual([8 * 1024 * 1024, 9 * 1024 * 1024]);
    await expect(stat(join(dir, 'big.mp4'))).rejects.toThrow();
  });

  it('leaves nothing behind when cancelled', async () => {
    await writeFile(join(dir, 'keep.mp4'), 'video');
    const controller = new AbortController();
    controller.abort();
    await expect(
      copyAndRemove(join(dir, 'keep.mp4'), join(dir, 'partial.mp4'), { signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
    await expect(stat(join(dir, 'partial.mp4'))).rejects.toThrow();
    expect(await readFile(join(dir, 'keep.mp4'), 'utf8')).toBe('video');
  });
});
