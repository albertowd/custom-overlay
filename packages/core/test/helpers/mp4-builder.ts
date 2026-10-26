/** Minimal MP4 writer used to build fixtures for the box parser. */

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function u32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (const [i, v] of values.entries()) view.setUint32(i * 4, v);
  return out;
}

function u16(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  for (const [i, v] of values.entries()) view.setUint16(i * 2, v);
  return out;
}

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([u32(body.byteLength + 8), ascii(type), body]);
}

export interface TrackSpec {
  id: number;
  handler: string;
  format: string;
  timescale: number;
  sampleDelta: number;
  samples: Uint8Array[];
  width?: number;
  height?: number;
  /** Child boxes of the visual sample entry (colr, hvcC...). */
  entryBoxes?: Uint8Array[];
}

function sampleEntry(spec: TrackSpec): Uint8Array {
  const base = concat([new Uint8Array(6), u16(1)]);
  if (spec.handler !== 'vide') return box(spec.format, base);
  // pre_defined/reserved (16) width height ... remaining visual sample entry fields
  return box(
    spec.format,
    base,
    new Uint8Array(16),
    u16(spec.width ?? 0, spec.height ?? 0),
    new Uint8Array(50),
    ...(spec.entryBoxes ?? []),
  );
}

function trak(spec: TrackSpec, chunkOffset: number): Uint8Array {
  const count = spec.samples.length;
  const duration = count * spec.sampleDelta;
  const tkhd = box(
    'tkhd',
    u32(0, 0, 0, spec.id, 0, duration),
    new Uint8Array(52),
    u32((spec.width ?? 0) * 65536, (spec.height ?? 0) * 65536),
  );
  const mdhd = box('mdhd', u32(0, 0, 0, spec.timescale, duration), new Uint8Array(4));
  const hdlr = box('hdlr', u32(0, 0), ascii(spec.handler), new Uint8Array(12), ascii('h\0'));
  const stsd = box('stsd', u32(0, 1), sampleEntry(spec));
  const stts = box('stts', u32(0, 1, count, spec.sampleDelta));
  const stsz = box('stsz', u32(0, 0, count, ...spec.samples.map((s) => s.byteLength)));
  // One chunk holding every sample.
  const stsc = box('stsc', u32(0, 1, 1, count, 1));
  const stco = box('stco', u32(0, 1, chunkOffset));
  const stbl = box('stbl', stsd, stts, stsz, stsc, stco);
  return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', stbl)));
}

/** Build a file laid out as ftyp, mdat (all samples), moov. `userData` boxes go in moov/udta. */
export function buildMp4(
  tracks: TrackSpec[],
  creationSeconds = 0,
  movieTimescale = 1000,
  userData: Uint8Array[] = [],
): Uint8Array {
  const ftyp = box('ftyp', ascii('isom'), u32(0), ascii('isommp41'));
  const payloads = tracks.map((t) => concat(t.samples));
  const mdat = box('mdat', ...payloads);
  let offset = ftyp.byteLength + 8;
  const traks = tracks.map((t, i) => {
    const result = trak(t, offset);
    offset += payloads[i]?.byteLength ?? 0;
    return result;
  });
  const movieDuration = Math.max(
    ...tracks.map((t) => ((t.samples.length * t.sampleDelta) / t.timescale) * movieTimescale),
  );
  const mvhd = box(
    'mvhd',
    u32(0, creationSeconds, creationSeconds, movieTimescale, movieDuration),
    new Uint8Array(80),
  );
  const udta = userData.length > 0 ? [box('udta', ...userData)] : [];
  return concat([ftyp, mdat, box('moov', mvhd, ...traks, ...udta)]);
}

/** GPMF KLV entry (type 0 = nested), padded to 4 bytes. */
export function klv(key: string, type: string | 0, structSize: number, payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(8);
  header.set(ascii(key), 0);
  header[4] = type === 0 ? 0 : type.charCodeAt(0);
  header[5] = structSize;
  new DataView(header.buffer).setUint16(6, payload.byteLength / structSize);
  const padded = new Uint8Array(Math.ceil(payload.byteLength / 4) * 4);
  padded.set(payload);
  return concat([header, padded]);
}

export { ascii, u32 };
