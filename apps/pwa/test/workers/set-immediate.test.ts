import { afterEach, describe, expect, it, vi } from 'vitest';

type Immediate = (callback: () => void) => void;
const scope = globalThis as { setImmediate?: Immediate };
const nodeSetImmediate = scope.setImmediate;
/** Read through a function: TypeScript would take it for undefined after `delete`. */
const current = (): Immediate | undefined => scope.setImmediate;

async function load(): Promise<void> {
  vi.resetModules();
  await import('../../src/set-immediate');
}

afterEach(() => {
  scope.setImmediate = nodeSetImmediate;
});

describe('setImmediate for workers', () => {
  it('adds a setImmediate that yields without the timer clamp, in order', async () => {
    delete scope.setImmediate;
    await load();
    const shim = current();
    expect(shim).toBeTypeOf('function');
    const calls: number[] = [];
    const done = new Promise<void>((resolve) => {
      shim?.(() => calls.push(1));
      shim?.(() => calls.push(2));
      shim?.(() => {
        calls.push(3);
        resolve();
      });
    });
    // Callbacks run later, never during the call.
    expect(calls).toEqual([]);
    await done;
    expect(calls).toEqual([1, 2, 3]);
  });

  it('yields far faster than nested timers', async () => {
    delete scope.setImmediate;
    await load();
    const shim = current() as Immediate;
    const started = performance.now();
    for (let i = 0; i < 500; i++) await new Promise<void>((resolve) => shim(resolve));
    // 500 nested browser timers take at least 2 s (4 ms each).
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('keeps a setImmediate the scope already has', async () => {
    const own = vi.fn();
    scope.setImmediate = own;
    await load();
    expect(current()).toBe(own);
  });
});
