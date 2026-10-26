import type { EngineOperation, EngineOperations, EngineRequest, EngineResponse } from './engine-protocol';

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

const worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
const pending = new Map<number, Pending>();
let nextId = 0;

worker.addEventListener('message', (event: MessageEvent<EngineResponse>) => {
  const response = event.data;
  const request = pending.get(response.id);
  if (!request) return;
  pending.delete(response.id);
  if (response.ok) request.resolve(response.result);
  else request.reject(new Error(response.message));
});

worker.addEventListener('error', (event) => {
  // The worker failed to start or crashed: nothing in flight will be answered.
  for (const request of pending.values()) request.reject(new Error(event.message || 'Engine worker failed'));
  pending.clear();
});

/** Run an operation in the engine worker. */
export function runInEngine<K extends EngineOperation>(
  operation: K,
  args: EngineOperations[K]['args'],
): Promise<EngineOperations[K]['result']> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
    worker.postMessage({ id, operation, args } as EngineRequest);
  });
}
