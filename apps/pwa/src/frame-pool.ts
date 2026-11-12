import type { FrameRendererInit } from '@custom-overlay/core';
import type { ExportWorkerRequest, ExportWorkerResponse, FrameFormat } from './export-protocol';

/** A drawn frame: a PNG file or a bitmap, with the widget errors met drawing it. */
export interface DrawnFrame<F extends FrameFormat> {
  data: F extends 'png' ? Uint8Array : ImageBitmap;
  warnings: string[];
}

interface Pending {
  resolve(frame: { data: Uint8Array | ImageBitmap; warnings: string[] }): void;
  reject(error: Error): void;
}

/** Drawing workers: half the cores (the page and the writes need the rest), 1 to 6. */
export const defaultWorkers = () =>
  Math.max(1, Math.min(6, Math.floor((navigator.hardwareConcurrency || 2) / 2)));

/** Workers drawing the widgets of export frames: frame n goes to worker n mod count. */
export class FramePool<F extends FrameFormat> {
  private readonly waiting: Map<number, Pending>[];

  private constructor(private readonly workers: Worker[]) {
    this.waiting = workers.map(() => new Map());
  }

  get size(): number {
    return this.workers.length;
  }

  static async start<F extends FrameFormat>(
    init: FrameRendererInit,
    count: number,
    format: F,
  ): Promise<FramePool<F>> {
    const workers = Array.from(
      { length: count },
      () => new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' }),
    );
    const pool = new FramePool<F>(workers);
    try {
      await Promise.all(workers.map((worker, w) => pool.listen(worker, w, init, format)));
    } catch (error) {
      pool.close();
      throw error;
    }
    return pool;
  }

  /** Wire a worker's answers; resolves once it is set up. */
  private listen(worker: Worker, w: number, init: FrameRendererInit, format: FrameFormat): Promise<void> {
    return new Promise((ready, failed) => {
      const fail = (error: Error) => {
        failed(error);
        for (const pending of this.waiting[w]?.values() ?? []) pending.reject(error);
        this.waiting[w]?.clear();
      };
      worker.addEventListener('error', (event) => fail(new Error(event.message || 'Export worker failed')));
      worker.addEventListener('message', (event: MessageEvent<ExportWorkerResponse>) => {
        const message = event.data;
        if (message.type === 'ready') ready();
        else if (message.type === 'error') fail(new Error(message.message));
        else {
          const data = message.type === 'frame' ? message.png : message.bitmap;
          this.waiting[w]?.get(message.frame)?.resolve({ data, warnings: message.warnings });
          this.waiting[w]?.delete(message.frame);
        }
      });
      worker.postMessage({ type: 'init', init, format } satisfies ExportWorkerRequest);
    });
  }

  frame(n: number): Promise<DrawnFrame<F>> {
    const w = n % this.workers.length;
    return new Promise((resolve, reject) => {
      this.waiting[w]?.set(n, { resolve: resolve as Pending['resolve'], reject });
      this.workers[w]?.postMessage({ type: 'frame', frame: n } satisfies ExportWorkerRequest);
    });
  }

  close(): void {
    for (const worker of this.workers) worker.terminate();
  }
}
