import type { RandomAccessReader } from '../io/reader.js';

/** Seconds between 1904-01-01 (MP4 epoch) and 1970-01-01. */
const MP4_EPOCH_OFFSET_SECONDS = 2_082_844_800;
const BOX_HEADER_SIZE = 8;

export interface Mp4Box {
  type: string;
  /** Absolute offset of the box header in the file. */
  offset: number;
  size: number;
  headerSize: number;
}

export interface SampleTable {
  /** Absolute file offset of each sample. */
  offsets: number[];
  sizes: number[];
  /** Decode time of each sample, in track timescale units. */
  times: number[];
  durations: number[];
}

export interface Mp4Track {
  id: number;
  /** Handler type: 'vide', 'soun', 'meta', 'tmcd'... */
  handlerType: string;
  /** Sample entry format: 'avc1', 'hvc1', 'mp4a', 'gpmd'... */
  format: string;
  timescale: number;
  duration: number;
  durationSeconds: number;
  sampleCount: number;
  width: number | null;
  height: number | null;
  /** Track (mdhd) creation time; GoPro cameras write local time here too. */
  creationTime: Date | null;
  /** Colour description of video tracks ('colr' box), when present. */
  color: Mp4ColorInfo | null;
  /** Luma bit depth of video tracks, when known from the decoder configuration. */
  bitDepth: number | null;
  samples: SampleTable;
}

export interface Mp4ColorInfo {
  primaries: number;
  transfer: number;
  matrix: number;
  fullRange: boolean;
}

export interface Mp4Info {
  timescale: number;
  durationSeconds: number;
  /** MP4 creation time. GoPro cameras write local time here, not UTC. */
  creationTime: Date | null;
  tracks: Mp4Track[];
  /** Payloads of the 'moov/udta' child boxes by type (GoPro: FIRM, LENS, CAME, GPMF...). */
  userData: Record<string, Uint8Array>;
}

export class Mp4ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mp4ParseError';
  }
}

function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function getUint64(view: DataView, offset: number): number {
  return Number(view.getBigUint64(offset));
}

/** Read the box header located at `offset`, or null if it is truncated. */
async function readBoxHeader(reader: RandomAccessReader, offset: number): Promise<Mp4Box | null> {
  if (offset + BOX_HEADER_SIZE > reader.size) return null;
  const bytes = await reader.read(offset, 16);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = view.getUint32(0);
  const type = fourcc(view, 4);
  let headerSize = BOX_HEADER_SIZE;
  if (size === 1) {
    if (bytes.byteLength < 16) return null;
    size = getUint64(view, 8);
    headerSize = 16;
  } else if (size === 0) {
    size = reader.size - offset;
  }
  if (size < headerSize) throw new Mp4ParseError(`Invalid size for box '${type}' at ${offset}`);
  return { type, offset, size, headerSize };
}

/** List the top level boxes of a file without reading their payloads. */
export async function listTopLevelBoxes(reader: RandomAccessReader): Promise<Mp4Box[]> {
  const boxes: Mp4Box[] = [];
  let offset = 0;
  while (offset < reader.size) {
    const box = await readBoxHeader(reader, offset);
    if (!box) break;
    boxes.push(box);
    offset += box.size;
  }
  return boxes;
}

/** In-memory view over a box payload (used for 'moov', which is small). */
class BoxView {
  readonly view: DataView;

  constructor(
    readonly type: string,
    readonly bytes: Uint8Array,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  children(): BoxView[] {
    const result: BoxView[] = [];
    let offset = 0;
    while (offset + BOX_HEADER_SIZE <= this.bytes.byteLength) {
      let size = this.view.getUint32(offset);
      const type = fourcc(this.view, offset + 4);
      let headerSize = BOX_HEADER_SIZE;
      if (size === 1) {
        size = getUint64(this.view, offset + 8);
        headerSize = 16;
      } else if (size === 0) {
        size = this.bytes.byteLength - offset;
      }
      if (size < headerSize || offset + size > this.bytes.byteLength) break;
      result.push(new BoxView(type, this.bytes.subarray(offset + headerSize, offset + size)));
      offset += size;
    }
    return result;
  }

  child(type: string): BoxView | undefined {
    return this.children().find((c) => c.type === type);
  }

  /** Follow a path of nested box types, e.g. path('mdia', 'minf', 'stbl'). */
  path(...types: string[]): BoxView | undefined {
    let current: BoxView | undefined = this;
    for (const type of types) {
      current = current?.child(type);
      if (!current) return undefined;
    }
    return current;
  }
}

function mp4TimeToDate(seconds: number): Date | null {
  if (seconds <= 0) return null;
  return new Date((seconds - MP4_EPOCH_OFFSET_SECONDS) * 1000);
}

function parseMvhd(box: BoxView): { timescale: number; duration: number; creation: number } {
  const v = box.view;
  if (v.getUint8(0) === 1) {
    return { creation: getUint64(v, 4), timescale: v.getUint32(20), duration: getUint64(v, 24) };
  }
  return { creation: v.getUint32(4), timescale: v.getUint32(12), duration: v.getUint32(16) };
}

function parseTkhd(box: BoxView): { id: number; width: number; height: number } {
  const v = box.view;
  const version = v.getUint8(0);
  const id = version === 1 ? v.getUint32(20) : v.getUint32(12);
  // width / height are the last 8 bytes, 16.16 fixed point.
  const end = box.bytes.byteLength;
  return { id, width: v.getUint32(end - 8) / 65536, height: v.getUint32(end - 4) / 65536 };
}

function parseMdhd(box: BoxView): { timescale: number; duration: number; creation: number } {
  const v = box.view;
  if (v.getUint8(0) === 1) {
    return { creation: getUint64(v, 4), timescale: v.getUint32(20), duration: getUint64(v, 24) };
  }
  return { creation: v.getUint32(4), timescale: v.getUint32(12), duration: v.getUint32(16) };
}

const VISUAL_FORMATS = ['avc1', 'avc3', 'hvc1', 'hev1', 'mp4v', 'av01', 'vp09', 'apch', 'apcn'];
/** Size of a VisualSampleEntry before its child boxes (header included). */
const VISUAL_SAMPLE_ENTRY_SIZE = 86;

interface SampleEntryInfo {
  format: string;
  width: number | null;
  height: number | null;
  color: Mp4ColorInfo | null;
  bitDepth: number | null;
}

/** 'nclx' colour information (ISO/IEC 23091-2 / H.273 code points). */
function parseColr(box: BoxView): Mp4ColorInfo | null {
  if (box.bytes.byteLength < 11) return null;
  const type = fourcc(box.view, 0);
  if (type !== 'nclx' && type !== 'nclc') return null;
  return {
    primaries: box.view.getUint16(4),
    transfer: box.view.getUint16(6),
    matrix: box.view.getUint16(8),
    fullRange: type === 'nclx' && (box.view.getUint8(10) & 0x80) !== 0,
  };
}

function parseSampleEntry(stsd: BoxView): SampleEntryInfo {
  // full box header (4) + entry count (4) + first entry: size (4) + format (4)
  const format = fourcc(stsd.view, 12);
  const info: SampleEntryInfo = { format, width: null, height: null, color: null, bitDepth: null };
  if (!VISUAL_FORMATS.includes(format) || stsd.bytes.byteLength < 8 + VISUAL_SAMPLE_ENTRY_SIZE) return info;

  const entryStart = 8;
  const entrySize = stsd.view.getUint32(entryStart);
  info.width = stsd.view.getUint16(entryStart + 32);
  info.height = stsd.view.getUint16(entryStart + 34);
  const children = new BoxView(
    format,
    stsd.bytes.subarray(entryStart + VISUAL_SAMPLE_ENTRY_SIZE, entryStart + entrySize),
  ).children();
  for (const child of children) {
    if (child.type === 'colr') info.color = parseColr(child) ?? info.color;
    // HEVCDecoderConfigurationRecord: bitDepthLumaMinus8 in the low 3 bits of byte 17.
    if (child.type === 'hvcC' && child.bytes.byteLength > 17) {
      info.bitDepth = (child.view.getUint8(17) & 0x07) + 8;
    }
    if (child.type === 'avcC') info.bitDepth ??= 8;
  }
  return info;
}

/** Parse a "full box" holding `count` fixed-size entries of uint32 fields. */
function readUint32Entries(box: BoxView, fieldsPerEntry: number): number[][] {
  const v = box.view;
  const count = v.getUint32(4);
  const start = 8;
  const entries: number[][] = [];
  for (let i = 0; i < count; i++) {
    const entry: number[] = [];
    for (let f = 0; f < fieldsPerEntry; f++) entry.push(v.getUint32(start + (i * fieldsPerEntry + f) * 4));
    entries.push(entry);
  }
  return entries;
}

function buildSampleTable(stbl: BoxView): SampleTable {
  const stts = stbl.child('stts');
  const stsz = stbl.child('stsz');
  const stsc = stbl.child('stsc');
  const stco = stbl.child('stco');
  const co64 = stbl.child('co64');
  if (!stts || !stsz || !stsc || (!stco && !co64)) {
    return { offsets: [], sizes: [], times: [], durations: [] };
  }

  // Sample sizes
  const sizes: number[] = [];
  const fixedSize = stsz.view.getUint32(4);
  const sampleCount = stsz.view.getUint32(8);
  for (let i = 0; i < sampleCount; i++) {
    sizes.push(fixedSize !== 0 ? fixedSize : stsz.view.getUint32(12 + i * 4));
  }

  // Decode times
  const times: number[] = [];
  const durations: number[] = [];
  let t = 0;
  for (const [count = 0, delta = 0] of readUint32Entries(stts, 2)) {
    for (let i = 0; i < count; i++) {
      times.push(t);
      durations.push(delta);
      t += delta;
    }
  }

  // Chunk offsets
  const chunkOffsets: number[] = [];
  if (co64) {
    const count = co64.view.getUint32(4);
    for (let i = 0; i < count; i++) chunkOffsets.push(getUint64(co64.view, 8 + i * 8));
  } else if (stco) {
    for (const [offset = 0] of readUint32Entries(stco, 1)) chunkOffsets.push(offset);
  }

  // Sample to chunk mapping -> per sample file offsets
  const stscEntries = readUint32Entries(stsc, 3);
  const offsets: number[] = [];
  let sample = 0;
  for (let e = 0; e < stscEntries.length; e++) {
    const [firstChunk = 1, samplesPerChunk = 0] = stscEntries[e] ?? [];
    const nextFirstChunk = stscEntries[e + 1]?.[0] ?? chunkOffsets.length + 1;
    for (let chunk = firstChunk; chunk < nextFirstChunk; chunk++) {
      let offset = chunkOffsets[chunk - 1] ?? 0;
      for (let s = 0; s < samplesPerChunk && sample < sizes.length; s++) {
        offsets.push(offset);
        offset += sizes[sample] ?? 0;
        sample++;
      }
    }
  }

  return { offsets, sizes, times, durations };
}

function parseTrack(trak: BoxView): Mp4Track | null {
  const tkhd = trak.child('tkhd');
  const mdhd = trak.path('mdia', 'mdhd');
  const hdlr = trak.path('mdia', 'hdlr');
  const stbl = trak.path('mdia', 'minf', 'stbl');
  const stsd = stbl?.child('stsd');
  if (!tkhd || !mdhd || !hdlr || !stbl || !stsd) return null;

  const header = parseTkhd(tkhd);
  const media = parseMdhd(mdhd);
  const sampleEntry = parseSampleEntry(stsd);
  const samples = buildSampleTable(stbl);
  const handlerType = fourcc(hdlr.view, 8);
  return {
    id: header.id,
    handlerType,
    format: sampleEntry.format,
    timescale: media.timescale,
    duration: media.duration,
    durationSeconds: media.timescale > 0 ? media.duration / media.timescale : 0,
    sampleCount: samples.sizes.length,
    width: sampleEntry.width ?? (header.width || null),
    height: sampleEntry.height ?? (header.height || null),
    creationTime: mp4TimeToDate(media.creation),
    color: sampleEntry.color,
    bitDepth: sampleEntry.bitDepth,
    samples,
  };
}

/** Parse the movie header and tracks of an MP4 / MOV file. */
export async function parseMp4(reader: RandomAccessReader): Promise<Mp4Info> {
  const boxes = await listTopLevelBoxes(reader);
  const moovBox = boxes.find((b) => b.type === 'moov');
  if (!moovBox) {
    throw new Mp4ParseError(
      boxes.length === 0 ? 'Not an MP4 file' : "No 'moov' box found (incomplete recording?)",
    );
  }
  const payload = await reader.read(moovBox.offset + moovBox.headerSize, moovBox.size - moovBox.headerSize);
  const moov = new BoxView('moov', payload);
  const mvhdBox = moov.child('mvhd');
  if (!mvhdBox) throw new Mp4ParseError("Missing 'mvhd' box");
  const mvhd = parseMvhd(mvhdBox);
  const tracks = moov
    .children()
    .filter((c) => c.type === 'trak')
    .map(parseTrack)
    .filter((t): t is Mp4Track => t !== null);
  const userData: Record<string, Uint8Array> = {};
  for (const box of moov.child('udta')?.children() ?? []) userData[box.type] = box.bytes;

  return {
    timescale: mvhd.timescale,
    durationSeconds: mvhd.timescale > 0 ? mvhd.duration / mvhd.timescale : 0,
    creationTime: mp4TimeToDate(mvhd.creation),
    tracks,
    userData,
  };
}

export function findVideoTrack(info: Mp4Info): Mp4Track | undefined {
  return info.tracks.find((t) => t.handlerType === 'vide');
}

/** Read the payload of every sample of a track, concatenated. */
export async function readTrackSamples(reader: RandomAccessReader, track: Mp4Track): Promise<Uint8Array> {
  const { offsets, sizes } = track.samples;
  const total = sizes.reduce((a, b) => a + b, 0);
  const out = new Uint8Array(total);
  let position = 0;
  let i = 0;
  while (i < offsets.length) {
    // Merge physically contiguous samples into one read.
    const start = offsets[i] as number;
    let length = sizes[i] as number;
    let j = i + 1;
    while (j < offsets.length && offsets[j] === start + length) {
      length += sizes[j] as number;
      j++;
    }
    const chunk = await reader.read(start, length);
    if (chunk.byteLength !== length) throw new Mp4ParseError('Unexpected end of file while reading samples');
    out.set(chunk, position);
    position += length;
    i = j;
  }
  return out;
}
