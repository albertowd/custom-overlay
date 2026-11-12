import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = () => void;

/** A service worker of the registration, with its state changes. */
class FakeWorker {
  state = 'installing';
  readonly listeners: Listener[] = [];
  readonly postMessage = vi.fn((data: unknown, ports?: MessagePort[]) => {
    if (data === 'version') ports?.[0]?.postMessage(this.version);
  });

  constructor(readonly version: unknown = '9.9.9') {}

  addEventListener(_type: 'statechange', fn: Listener) {
    this.listeners.push(fn);
  }

  become(state: string) {
    this.state = state;
    for (const fn of this.listeners) fn();
  }
}

class FakeRegistration {
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  readonly found: Listener[] = [];
  readonly update = vi.fn(async () => undefined);

  addEventListener(_type: 'updatefound', fn: Listener) {
    this.found.push(fn);
  }
}

let registration: FakeRegistration;
let controller: object | null;
const containerListeners: Record<string, Listener> = {};

async function load() {
  vi.resetModules();
  const updates = await import('../../src/updates');
  updates.registerServiceWorker();
  return updates;
}

beforeEach(() => {
  registration = new FakeRegistration();
  controller = {};
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: vi.fn(async () => registration),
      get controller() {
        return controller;
      },
      addEventListener: (type: string, fn: Listener) => {
        containerListeners[type] = fn;
      },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('web app updates', () => {
  it('finds a version already waiting, and asks it which it is', async () => {
    const { waitingWorker, versionOf } = await load();
    const worker = new FakeWorker('0.3.0');
    registration.waiting = worker;
    const found = await waitingWorker();
    expect(found).toBe(worker);
    expect(await versionOf(found as never)).toBe('0.3.0');
  });

  it('waits for a version that is being installed', async () => {
    const { waitingWorker } = await load();
    const worker = new FakeWorker();
    const pending = waitingWorker();
    await Promise.resolve();
    await Promise.resolve();
    registration.installing = worker;
    for (const fn of registration.found) fn();
    registration.waiting = worker;
    worker.become('installed');
    expect(await pending).toBe(worker);
    expect(registration.update).toHaveBeenCalled();
  });

  it('offers nothing on the first visit, or when no new version comes', async () => {
    vi.useFakeTimers();
    controller = null;
    const first = await load();
    registration.waiting = new FakeWorker();
    expect(await first.waitingWorker()).toBeNull();

    controller = {};
    registration.waiting = null;
    const later = await load();
    const pending = later.waitingWorker(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBeNull();
  });

  it('gives up on a version that fails to install', async () => {
    const { waitingWorker } = await load();
    const worker = new FakeWorker();
    registration.installing = worker;
    const pending = waitingWorker();
    await Promise.resolve();
    await Promise.resolve();
    worker.become('redundant');
    expect(await pending).toBeNull();
  });

  it('has no version from a service worker that does not answer', async () => {
    vi.useFakeTimers();
    const { versionOf } = await load();
    const silent = { postMessage: vi.fn() };
    const pending = versionOf(silent as never, 500);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toBeNull();
  });

  it('starts the waiting version, reloading once it took over', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    const { startWaitingVersion } = await load();
    const worker = new FakeWorker();
    registration.waiting = worker;
    await startWaitingVersion();
    expect(worker.postMessage).toHaveBeenCalledWith('skip-waiting');
    expect(reload).not.toHaveBeenCalled();
    containerListeners.controllerchange?.();
    expect(reload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
