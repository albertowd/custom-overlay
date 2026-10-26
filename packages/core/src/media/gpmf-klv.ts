/**
 * Minimal GPMF KLV reader. Each entry is: key (4 chars), type (1 byte, 0 = nested), struct size
 * (1 byte), repeat (uint16 BE), then `size * repeat` bytes of payload padded to 4 bytes.
 */
export interface KlvEntry {
  key: string;
  type: number;
  structSize: number;
  repeat: number;
  payload: Uint8Array;
}

export function* iterateKlv(data: Uint8Array): Generator<KlvEntry> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  while (offset + 8 <= data.byteLength) {
    const key = String.fromCharCode(
      data[offset] ?? 0,
      data[offset + 1] ?? 0,
      data[offset + 2] ?? 0,
      data[offset + 3] ?? 0,
    );
    const type = view.getUint8(offset + 4);
    const structSize = view.getUint8(offset + 5);
    const repeat = view.getUint16(offset + 6);
    const length = structSize * repeat;
    if (offset + 8 + length > data.byteLength) return;
    yield { key, type, structSize, repeat, payload: data.subarray(offset + 8, offset + 8 + length) };
    offset += 8 + Math.ceil(length / 4) * 4;
  }
}

/** Depth first search of a key, descending into nested (type 0) entries. */
export function findKlv(data: Uint8Array, key: string): KlvEntry | null {
  for (const entry of iterateKlv(data)) {
    if (entry.key === key) return entry;
    if (entry.type === 0) {
      const nested = findKlv(entry.payload, key);
      if (nested) return nested;
    }
  }
  return null;
}

/** Decode a NUL padded ASCII/UTF-8 string, null when empty. */
export function decodeText(bytes: Uint8Array | undefined): string | null {
  if (!bytes) return null;
  return new TextDecoder().decode(bytes).split('\0').join('').trim() || null;
}

export function klvString(entry: KlvEntry | null): string | null {
  return entry ? decodeText(entry.payload) : null;
}
