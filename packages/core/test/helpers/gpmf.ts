/** Split a raw GPMF track into its top level DEVC payloads (one per MP4 sample). */
export function splitGpmfPayloads(raw: Uint8Array): Uint8Array[] {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const payloads: Uint8Array[] = [];
  let offset = 0;
  while (offset + 8 <= raw.byteLength) {
    const size = view.getUint8(offset + 5);
    const repeat = view.getUint16(offset + 6);
    const length = 8 + Math.ceil((size * repeat) / 4) * 4;
    payloads.push(raw.subarray(offset, offset + length));
    offset += length;
  }
  return payloads;
}
