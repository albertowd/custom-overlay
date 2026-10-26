import { vi } from 'vitest';

/** A Worker that records what the page posts and answers when the test says so. */
export class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  readonly posted: unknown[] = [];
  terminated = false;
  /** Called for each posted message: lets a test answer automatically. */
  onPost: ((message: unknown) => void) | null = null;

  constructor(
    readonly url: URL | string,
    readonly options?: WorkerOptions,
  ) {
    super();
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
    this.onPost?.(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** The worker answers `data`. */
  reply(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  /** The worker fails (a script error, or it could not start). */
  fail(message: string): void {
    const event = new Event('error') as ErrorEvent;
    Object.defineProperty(event, 'message', { value: message });
    this.dispatchEvent(event);
  }
}

/** Replace the global Worker with `FakeWorker` (and forget earlier instances). */
export function installFakeWorker(): void {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
}
