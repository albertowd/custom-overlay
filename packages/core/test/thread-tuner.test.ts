import { describe, expect, it } from 'vitest';
import { ThreadTuner } from '../src/export/thread-tuner.js';

describe('thread tuner', () => {
  it('adds threads while drawing holds the export back and they make it faster', () => {
    const tuner = new ThreadTuner(2, { min: 1, max: 8 });
    expect(tuner.next({ fps: 10, waitingOn: 'drawing' })).toBe('add');
    expect(tuner.count).toBe(3);
    // Faster: kept.
    expect(tuner.next({ fps: 14, waitingOn: 'drawing' })).toBe('hold');
    expect(tuner.next({ fps: 14, waitingOn: 'drawing' })).toBe('add');
    expect(tuner.count).toBe(4);
  });

  it('takes a thread back when it did not help, and leaves that count alone for a while', () => {
    const tuner = new ThreadTuner(4, { min: 1, max: 8 });
    expect(tuner.next({ fps: 20, waitingOn: 'drawing' })).toBe('add');
    // Barely faster (memory bandwidth, slow cores): not worth it.
    expect(tuner.next({ fps: 20.5, waitingOn: 'drawing' })).toBe('remove');
    expect(tuner.count).toBe(4);
    for (let i = 0; i < 8; i++) expect(tuner.next({ fps: 20, waitingOn: 'drawing' })).toBe('hold');
    // Later (the computer may be less busy now) it tries again.
    let decision = tuner.next({ fps: 20, waitingOn: 'drawing' });
    if (decision === 'hold') decision = tuner.next({ fps: 20, waitingOn: 'drawing' });
    expect(decision).toBe('add');
  });

  it('removes threads while ffmpeg holds the export back, unless that slows it down', () => {
    const tuner = new ThreadTuner(6, { min: 1, max: 8 });
    expect(tuner.next({ fps: 30, waitingOn: 'encoder' })).toBe('remove');
    expect(tuner.count).toBe(5);
    // As fast with one fewer: kept (a core more for ffmpeg).
    expect(tuner.next({ fps: 29.5, waitingOn: 'encoder' })).toBe('hold');
    expect(tuner.next({ fps: 29.5, waitingOn: 'encoder' })).toBe('remove');
    // Slower: back.
    expect(tuner.next({ fps: 25, waitingOn: 'encoder' })).toBe('add');
    expect(tuner.count).toBe(5);
    expect(tuner.next({ fps: 30, waitingOn: 'encoder' })).toBe('hold');
  });

  it('stays within its limits and holds when nothing waits', () => {
    const tuner = new ThreadTuner(10, { min: 1, max: 3 });
    expect(tuner.count).toBe(3);
    expect(tuner.next({ fps: 10, waitingOn: 'drawing' })).toBe('hold');
    expect(tuner.next({ fps: 10, waitingOn: null })).toBe('hold');
    const single = new ThreadTuner(1, { min: 1, max: 4 });
    expect(single.next({ fps: 10, waitingOn: 'encoder' })).toBe('hold');
  });
});
