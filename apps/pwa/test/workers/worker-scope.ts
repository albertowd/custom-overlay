import { vi } from 'vitest';

/**
 * A dedicated worker's global scope in Node: the module under test listens with
 * `addEventListener('message')` and answers with `postMessage`. Import the worker module after
 * calling this.
 */
export function workerScope<Request, Response>() {
  let listener: ((event: MessageEvent<Request>) => void) | null = null;
  const answers: { data: Response; transfer: Transferable[] }[] = [];
  const waiting: ((data: Response) => void)[] = [];
  vi.stubGlobal('addEventListener', (type: string, handler: (event: MessageEvent<Request>) => void) => {
    if (type === 'message') listener = handler;
  });
  vi.stubGlobal('postMessage', (data: Response, options?: { transfer?: Transferable[] }) => {
    answers.push({ data, transfer: options?.transfer ?? [] });
    waiting.shift()?.(data);
  });
  return {
    answers,
    /** Post `request` to the worker. */
    post(request: Request): void {
      if (!listener) throw new Error('The worker module is not listening');
      listener({ data: request } as MessageEvent<Request>);
    },
    /** The worker's next answer. */
    next(): Promise<Response> {
      return new Promise((resolve) => waiting.push(resolve));
    },
  };
}
