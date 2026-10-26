/**
 * Random access to a binary resource (a file on disk, a browser File, a buffer...). The engine
 * never loads whole media files in memory: GoPro chapters can be up to 4 GB.
 */
export interface RandomAccessReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  close?(): Promise<void>;
}

export class MemoryReader implements RandomAccessReader {
  constructor(private readonly data: Uint8Array) {}

  get size(): number {
    return this.data.byteLength;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    return this.data.subarray(offset, Math.min(offset + length, this.data.byteLength));
  }
}
