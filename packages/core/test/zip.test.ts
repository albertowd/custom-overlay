import { describe, expect, it } from 'vitest';
import { crc32, ZipWriter } from '../src/io/zip.js';

interface ReadEntry {
  name: string;
  data: Uint8Array;
}

/** A minimal ZIP reader (stored entries, Zip64 end records), to check what the writer produces. */
function readZip(zip: Uint8Array): { entries: ReadEntry[]; zip64: boolean } {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.byteLength - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  let count = view.getUint16(end + 10, true);
  let directory = view.getUint32(end + 16, true);
  const zip64 = view.getUint32(end - 20, true) === 0x07064b50;
  if (zip64) {
    const record = Number(view.getBigUint64(end - 20 + 8, true));
    expect(view.getUint32(record, true)).toBe(0x06064b50);
    count = Number(view.getBigUint64(record + 32, true));
    directory = Number(view.getBigUint64(record + 48, true));
  }
  const entries: ReadEntry[] = [];
  let at = directory;
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    expect(view.getUint32(offset, true)).toBe(0x04034b50);
    const dataStart = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const data = zip.subarray(dataStart, dataStart + size);
    expect(crc32(data)).toBe(crc);
    entries.push({ name, data });
    at += 46 + nameLength + extraLength;
  }
  return { entries, zip64 };
}

async function build(files: [string, Uint8Array][]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const zip = new ZipWriter(
    (chunk) => {
      chunks.push(chunk);
    },
    new Date(2026, 9, 24, 14, 5, 30),
  );
  for (const [name, data] of files) await zip.add(name, data);
  await zip.finish();
  const out = new Uint8Array(zip.size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

describe('ZIP writer', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('stores files that read back unchanged', async () => {
    const files: [string, Uint8Array][] = [
      ['frame_000000.png', new Uint8Array([137, 80, 78, 71, 1, 2, 3])],
      ['frame_000001.png', new Uint8Array(1000).fill(7)],
      ['ünïcødé.txt', new TextEncoder().encode('names are UTF-8')],
    ];
    const { entries, zip64 } = readZip(await build(files));
    expect(zip64).toBe(false);
    expect(entries.map((e) => e.name)).toEqual(files.map(([name]) => name));
    expect(entries.map((e) => e.data)).toEqual(files.map(([, data]) => data));
  });

  it('writes an empty archive', async () => {
    expect((await build([])).byteLength).toBe(22);
  });

  it('adds Zip64 end records past 65,535 files', async () => {
    const files = Array.from({ length: 70_000 }, (_, i): [string, Uint8Array] => [
      `f${i}`,
      new Uint8Array([i & 255]),
    ]);
    const { entries, zip64 } = readZip(await build(files));
    expect(zip64).toBe(true);
    expect(entries).toHaveLength(70_000);
    expect(entries[69_999]?.name).toBe('f69999');
  });

  it('refuses entries after the end', async () => {
    const zip = new ZipWriter(() => undefined);
    await zip.finish();
    await expect(zip.add('late', new Uint8Array(1))).rejects.toThrow('finished');
  });
});
