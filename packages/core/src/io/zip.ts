// Streaming ZIP writer for image sequences: entries are stored (PNG is already compressed) and
// written as they come, so an export never sits whole in memory. Zip64 records are added when
// the archive needs them: more than 65,535 files (18 minutes at 60 fps) or more than 4 GiB.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (ZIP, PNG, gzip). */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const MAX_16 = 0xffff;
const MAX_32 = 0xffffffff;
/** UTF-8 file names. */
const FLAG_UTF8 = 0x0800;
/** Version needed: 2.0 for plain entries, 4.5 for Zip64. */
const VERSION = 20;
const VERSION_ZIP64 = 45;

/** Receives the archive's bytes, in order. */
export type ZipSink = (chunk: Uint8Array) => void | Promise<void>;

interface CentralEntry {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
}

class Bytes {
  private readonly buffer: Uint8Array;
  private readonly view: DataView;
  private at = 0;

  constructor(size: number) {
    this.buffer = new Uint8Array(size);
    this.view = new DataView(this.buffer.buffer);
  }

  u16(value: number): this {
    this.view.setUint16(this.at, value, true);
    this.at += 2;
    return this;
  }

  u32(value: number): this {
    this.view.setUint32(this.at, value, true);
    this.at += 4;
    return this;
  }

  u64(value: number): this {
    this.view.setBigUint64(this.at, BigInt(value), true);
    this.at += 8;
    return this;
  }

  bytes(data: Uint8Array): this {
    this.buffer.set(data, this.at);
    this.at += data.byteLength;
    return this;
  }

  get data(): Uint8Array {
    return this.buffer;
  }
}

/** MS-DOS date and time of the entries (local time, 2-second steps, from 1980). */
function dosDateTime(date: Date): { time: number; day: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export class ZipWriter {
  private offset = 0;
  private readonly entries: CentralEntry[] = [];
  private readonly stamp: { time: number; day: number };
  private finished = false;

  constructor(
    private readonly sink: ZipSink,
    modified = new Date(),
  ) {
    this.stamp = dosDateTime(modified);
  }

  /** Bytes written so far. */
  get size(): number {
    return this.offset;
  }

  private async emit(chunk: Uint8Array): Promise<void> {
    await this.sink(chunk);
    this.offset += chunk.byteLength;
  }

  /** Add a file (stored, under 4 GiB). */
  async add(fileName: string, data: Uint8Array): Promise<void> {
    if (this.finished) throw new Error('The archive is finished');
    if (data.byteLength >= MAX_32) throw new Error(`'${fileName}' is too large for the archive`);
    const name = new TextEncoder().encode(fileName);
    const entry: CentralEntry = { name, crc: crc32(data), size: data.byteLength, offset: this.offset };
    const header = new Bytes(30 + name.byteLength)
      .u32(0x04034b50)
      .u16(VERSION)
      .u16(FLAG_UTF8)
      .u16(0) // stored
      .u16(this.stamp.time)
      .u16(this.stamp.day)
      .u32(entry.crc)
      .u32(entry.size)
      .u32(entry.size)
      .u16(name.byteLength)
      .u16(0)
      .bytes(name);
    await this.emit(header.data);
    await this.emit(data);
    this.entries.push(entry);
  }

  /** Write the central directory; nothing can be added after. */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const directoryOffset = this.offset;
    for (const entry of this.entries) {
      const zip64 = entry.offset >= MAX_32;
      const record = new Bytes(46 + entry.name.byteLength + (zip64 ? 12 : 0))
        .u32(0x02014b50)
        .u16(VERSION_ZIP64)
        .u16(zip64 ? VERSION_ZIP64 : VERSION)
        .u16(FLAG_UTF8)
        .u16(0)
        .u16(this.stamp.time)
        .u16(this.stamp.day)
        .u32(entry.crc)
        .u32(entry.size)
        .u32(entry.size)
        .u16(entry.name.byteLength)
        .u16(zip64 ? 12 : 0)
        .u16(0) // comment
        .u16(0) // disk
        .u16(0) // internal attributes
        .u32(0) // external attributes
        .u32(zip64 ? MAX_32 : entry.offset)
        .bytes(entry.name);
      // Zip64 extra field: only the offset overflows (entries are under 4 GiB).
      if (zip64) record.u16(0x0001).u16(8).u64(entry.offset);
      await this.emit(record.data);
    }
    const directorySize = this.offset - directoryOffset;
    const count = this.entries.length;
    if (count > MAX_16 || directoryOffset >= MAX_32 || directorySize >= MAX_32) {
      const zip64End = this.offset;
      await this.emit(
        new Bytes(56)
          .u32(0x06064b50)
          .u64(44) // size of the rest of the record
          .u16(VERSION_ZIP64)
          .u16(VERSION_ZIP64)
          .u32(0)
          .u32(0)
          .u64(count)
          .u64(count)
          .u64(directorySize)
          .u64(directoryOffset).data,
      );
      await this.emit(new Bytes(20).u32(0x07064b50).u32(0).u64(zip64End).u32(1).data);
    }
    await this.emit(
      new Bytes(22)
        .u32(0x06054b50)
        .u16(0)
        .u16(0)
        .u16(Math.min(count, MAX_16))
        .u16(Math.min(count, MAX_16))
        .u32(Math.min(directorySize, MAX_32))
        .u32(Math.min(directoryOffset, MAX_32))
        .u16(0).data,
    );
  }
}
