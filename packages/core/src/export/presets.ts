import type { EncoderSettings, OutputSettings } from '../model/project.js';

/** The two columns of YouTube's bitrate tables: 24-30 fps and 48-60 fps. */
export type FrameRateClass = 'standard' | 'high';

/** A row of YouTube's bitrate tables: [min, max] Mbps per frame rate column. */
interface BitrateRow {
  /** Short side of the frame (vertical resolution of a landscape video). */
  lines: number;
  label: string;
  standard: [number, number];
  high: [number, number];
}

/** YouTube recommended SDR upload bitrates (support.google.com/youtube/answer/1722171). */
const YOUTUBE_SDR: readonly BitrateRow[] = [
  { lines: 4320, label: '4320p (8K)', standard: [80, 160], high: [120, 240] },
  { lines: 2160, label: '2160p (4K)', standard: [35, 45], high: [53, 68] },
  { lines: 1440, label: '1440p (2K)', standard: [16, 16], high: [24, 24] },
  { lines: 1080, label: '1080p', standard: [8, 8], high: [12, 12] },
  { lines: 720, label: '720p', standard: [5, 5], high: [7.5, 7.5] },
  { lines: 480, label: '480p', standard: [2.5, 2.5], high: [4, 4] },
  { lines: 360, label: '360p', standard: [1, 1], high: [1.5, 1.5] },
];

/** HDR uploads start at 720p (support.google.com/youtube/answer/7126552). */
const YOUTUBE_HDR: readonly BitrateRow[] = [
  { lines: 4320, label: '4320p (8K)', standard: [100, 200], high: [150, 300] },
  { lines: 2160, label: '2160p (4K)', standard: [44, 56], high: [66, 85] },
  { lines: 1440, label: '1440p (2K)', standard: [20, 20], high: [30, 30] },
  { lines: 1080, label: '1080p', standard: [10, 10], high: [15, 15] },
  { lines: 720, label: '720p', standard: [6.5, 6.5], high: [9.5, 9.5] },
];

/** 16:9 frame widths of the table rows (480p is 854 wide on YouTube). */
const WIDE_WIDTHS: Record<number, number> = {
  4320: 7680,
  2160: 3840,
  1440: 2560,
  1080: 1920,
  720: 1280,
  480: 854,
  360: 640,
};

/** YouTube's recommended AAC bitrate for stereo (128 kbps mono, 512 kbps 5.1); exports are stereo. */
const YOUTUBE_AUDIO_KBPS = 384;

const FRAME_RATE_COLUMNS: readonly {
  cls: FrameRateClass;
  suffix: string;
  label: string;
  range: [number, number];
}[] = [
  { cls: 'standard', suffix: '30', label: '24–30 fps', range: [23, 30.5] },
  { cls: 'high', suffix: '60', label: '48–60 fps', range: [47, 60.5] },
];

export function isHdr(output: OutputSettings): boolean {
  return output.color.space === 'rec2020-hlg' || output.color.space === 'rec2020-pq';
}

/** Column of YouTube's bitrate tables for a frame rate. */
export function frameRateClass(frameRate: number): FrameRateClass {
  return frameRate > 30.5 ? 'high' : 'standard';
}

/**
 * A frame rate of a class derived from `frameRate` by halving or doubling, so frames are dropped
 * or repeated evenly: 119.88 fps gives 59.94 (high) or 29.97 (standard), 50 gives 25, 24 gives 48.
 */
export function frameRateIn(frameRate: number, cls: FrameRateClass): number {
  const column = FRAME_RATE_COLUMNS.find((c) => c.cls === cls);
  const [min, max] = column?.range ?? [0, Number.POSITIVE_INFINITY];
  for (const factor of [1, 1 / 2, 2, 1 / 4, 4, 1 / 8]) {
    const candidate = Math.round(frameRate * factor * 1000) / 1000;
    if (candidate >= min && candidate <= max) return candidate;
  }
  return cls === 'high' ? 60 : 30;
}

/** The table row nearest to an output's short side: 2.7K (1520 lines) uses 1440p, not 4K. */
function nearestRow(table: readonly BitrateRow[], output: OutputSettings): BitrateRow {
  // Short side, so portrait videos map to the same row as their landscape equivalent.
  const lines = Math.min(output.width, output.height);
  let row = table[0] as BitrateRow;
  for (const candidate of table) {
    if (Math.abs(candidate.lines - lines) < Math.abs(row.lines - lines)) row = candidate;
  }
  return row;
}

/**
 * Recommended YouTube bitrate for an output format: the top of YouTube's range, from the SDR or
 * HDR table and the frame rate column (by default the ones matching the output).
 */
export function youtubeBitrateMbps(
  output: OutputSettings,
  hdr = isHdr(output),
  frameRate: FrameRateClass = frameRateClass(output.frameRate),
): number {
  return nearestRow(hdr ? YOUTUBE_HDR : YOUTUBE_SDR, output)[frameRate][1];
}

/**
 * Frame size of a table row keeping the output's orientation and aspect ratio: the 16:9 sizes
 * YouTube lists (3840 × 2160...), else the short side at the row and the long side scaled.
 */
export function frameSizeFor(lines: number, output: OutputSettings): { width: number; height: number } {
  const portrait = output.height > output.width;
  const aspect = Math.max(output.width, output.height) / Math.min(output.width, output.height);
  const wide = Math.abs(aspect - 16 / 9) < 0.02 ? WIDE_WIDTHS[lines] : undefined;
  const long = wide ?? Math.round((lines * aspect) / 2) * 2;
  return portrait ? { width: lines, height: long } : { width: long, height: lines };
}

/** Why a preset does not suit an output format (messages `export.encoding.notes.<code>`). */
export type PresetNote =
  | 'sdrConverted'
  | 'h264TenBit'
  | 'hdrNeedsHdrOutput'
  | 'hdrResolution'
  | 'frameRate'
  | 'socialSdr'
  | 'socialSize'
  | 'socialFrameRate';

/** One YouTube codec choice; it makes a preset per cell of its bitrate table. */
export interface YoutubeFamily {
  id: string;
  label: string;
  description: string;
  codec: EncoderSettings['codec'];
  hdr: boolean;
}

/** The cell of YouTube's bitrate tables a YouTube preset is made for. */
export interface YoutubeTarget {
  family: YoutubeFamily;
  /** Short side of the frame, e.g. 2160. */
  lines: number;
  /** e.g. `2160p (4K)`. */
  resolution: string;
  frameRate: FrameRateClass;
  /** e.g. `48–60 fps`. */
  fps: string;
  bitrateMbps: number;
}

/** A social network format (TikTok, Instagram Reels...); it makes a preset per frame rate column. */
export interface SocialFamily {
  id: string;
  label: string;
  description: string;
  /** The canvas the platform shows full screen, e.g. 1080 × 1920. */
  width: number;
  height: number;
  /** Recommended H.264 bitrate per frame rate column. */
  bitrateMbps: Record<FrameRateClass, number>;
}

/** The format and frame rate a social preset is made for. */
export interface SocialTarget {
  family: SocialFamily;
  frameRate: FrameRateClass;
  /** e.g. `48–60 fps`. */
  fps: string;
  bitrateMbps: number;
}

export interface EncodePreset {
  id: string;
  label: string;
  description: string;
  /** YouTube presets: choosing one moves the output to its resolution and frame rate. */
  youtube?: YoutubeTarget;
  /** Social presets: choosing one moves the output (the canvas) to its size and frame rate. */
  social?: SocialTarget;
  /** Encoder settings for an output format. */
  settings(output: OutputSettings): Omit<EncoderSettings, 'preset' | 'acceleration'>;
  /** Output formats the preset does not suit; none by default. */
  notes?(output: OutputSettings): PresetNote[];
}

export const YOUTUBE_FAMILIES: readonly YoutubeFamily[] = [
  {
    id: 'youtube-sdr-h264',
    label: 'YouTube SDR · H.264',
    description:
      "YouTube's recommended upload settings: H.264 High, 2 B-frames, closed GOP of half the frame rate, AAC 384 kbps.",
    codec: 'h264',
    hdr: false,
  },
  {
    id: 'youtube-sdr-hevc',
    label: 'YouTube SDR · HEVC',
    description:
      "YouTube's SDR settings with H.265, which YouTube also accepts: encodes 10-bit footage on the GPU.",
    codec: 'hevc',
    hdr: false,
  },
  {
    id: 'youtube-hdr-hevc',
    label: 'YouTube HDR · HEVC',
    description:
      "YouTube's HDR recommendations: 10-bit H.265 for a Rec.2020 HLG or PQ output, 2 B-frames, closed GOP of half the frame rate, AAC 384 kbps.",
    codec: 'hevc',
    hdr: true,
  },
  {
    id: 'youtube-hdr-av1',
    label: 'YouTube HDR · AV1',
    description:
      "YouTube's HDR recommendations with AV1, also recommended for HDR: fast on GPUs with AV1 encoding, slow on the CPU.",
    codec: 'av1',
    hdr: true,
  },
];

/** Sentence after a YouTube family's description (translated as `core.presets.youtubeBitrate`). */
export const YOUTUBE_BITRATE_TEXT =
  "{bitrate} Mbps: the top of YouTube's {table} range for {resolution} at {fps}.";

const sdrNotes = (codec: EncoderSettings['codec'], output: OutputSettings) => {
  const notes: PresetNote[] = [];
  // YouTube turns SDR uploads into 8-bit BT.709 limited range anyway.
  if (output.color.space !== 'rec709' || output.color.range === 'full') notes.push('sdrConverted');
  if (codec === 'h264' && output.color.bitDepth === 10) notes.push('h264TenBit');
  return notes;
};

const hdrNotes = (output: OutputSettings) => {
  const notes: PresetNote[] = [];
  if (!isHdr(output) || output.color.bitDepth !== 10) notes.push('hdrNeedsHdrOutput');
  if (Math.min(output.width, output.height) < 720) notes.push('hdrResolution');
  return notes;
};

const youtubeId = (family: YoutubeFamily, lines: number, column: { suffix: string }) =>
  `${family.id}-${lines}p${column.suffix}`;

function youtubePreset(
  family: YoutubeFamily,
  row: BitrateRow,
  column: (typeof FRAME_RATE_COLUMNS)[number],
): EncodePreset {
  const target: YoutubeTarget = {
    family,
    lines: row.lines,
    resolution: row.label,
    frameRate: column.cls,
    fps: column.label,
    bitrateMbps: row[column.cls][1],
  };
  const bitrate = YOUTUBE_BITRATE_TEXT.replace('{bitrate}', String(target.bitrateMbps))
    .replace('{table}', family.hdr ? 'HDR' : 'SDR')
    .replace('{resolution}', row.label)
    .replace('{fps}', column.label);
  return {
    id: youtubeId(family, row.lines, column),
    label: `${family.label} · ${row.label} · ${column.label}`,
    description: `${family.description} ${bitrate}`,
    youtube: target,
    settings: () => ({
      codec: family.codec,
      bitrateMbps: target.bitrateMbps,
      // 2 B-frames, closed GOP of half the frame rate.
      keyframeIntervalSeconds: 0.5,
      bFrames: 2,
      audio: 'aac',
      audioBitrateKbps: YOUTUBE_AUDIO_KBPS,
    }),
    notes: (output) => {
      const notes = family.hdr ? hdrNotes(output) : sdrNotes(family.codec, output);
      // Edited by hand outside the column (e.g. 120 fps): YouTube plays 60 fps at most.
      const [min, max] = column.range;
      if (output.frameRate < min || output.frameRate > max) notes.push('frameRate');
      return notes;
    },
  };
}

/**
 * Vertical and feed formats of the short video apps. Neither publishes upload bitrates and both
 * re-encode every upload: these are YouTube's 1080p rates (less for the smaller 4:5 frame), as
 * more only makes the upload bigger.
 */
export const SOCIAL_FAMILIES: readonly SocialFamily[] = [
  {
    id: 'tiktok',
    label: 'TikTok · 9:16',
    description:
      'Full screen vertical 1080 × 1920 video for TikTok: H.264 High, 2 B-frames, 1 s GOP, AAC 192 kbps.',
    width: 1080,
    height: 1920,
    bitrateMbps: { standard: 8, high: 12 },
  },
  {
    id: 'instagram-reels',
    label: 'Instagram Reels · 9:16',
    description:
      'Full screen vertical 1080 × 1920 video for Instagram Reels and Stories: H.264 High, 2 B-frames, 1 s GOP, AAC 192 kbps.',
    width: 1080,
    height: 1920,
    bitrateMbps: { standard: 8, high: 12 },
  },
  {
    id: 'instagram-feed',
    label: 'Instagram feed · 4:5',
    description:
      'Portrait 1080 × 1350 video, the tallest Instagram shows in the feed: H.264 High, 2 B-frames, 1 s GOP, AAC 192 kbps.',
    width: 1080,
    height: 1350,
    bitrateMbps: { standard: 6, high: 9 },
  },
];

/** Sentence after a social family's description (translated as `core.presets.socialBitrate`). */
export const SOCIAL_BITRATE_TEXT = '{bitrate} Mbps at {fps}: the app re-encodes every upload.';

function socialPreset(family: SocialFamily, column: (typeof FRAME_RATE_COLUMNS)[number]): EncodePreset {
  const target: SocialTarget = {
    family,
    frameRate: column.cls,
    fps: column.label,
    bitrateMbps: family.bitrateMbps[column.cls],
  };
  const bitrate = SOCIAL_BITRATE_TEXT.replace('{bitrate}', String(target.bitrateMbps)).replace(
    '{fps}',
    column.label,
  );
  return {
    id: `${family.id}-${column.suffix}`,
    label: `${family.label} · ${column.label}`,
    description: `${family.description} ${bitrate}`,
    social: target,
    settings: () => ({
      codec: 'h264',
      bitrateMbps: target.bitrateMbps,
      keyframeIntervalSeconds: 1,
      bFrames: 2,
      audio: 'aac',
      audioBitrateKbps: 192,
    }),
    notes: (output) => {
      const notes: PresetNote[] = [];
      // The apps play 8-bit Rec.709 SDR.
      if (output.color.space !== 'rec709' || output.color.range === 'full' || output.color.bitDepth === 10) {
        notes.push('socialSdr');
      }
      if (output.width !== family.width || output.height !== family.height) notes.push('socialSize');
      const [min, max] = column.range;
      if (output.frameRate < min || output.frameRate > max) notes.push('socialFrameRate');
      return notes;
    },
  };
}

/** The format of a social preset, undefined for other presets. */
export function socialTargetOf(presetId: string): SocialTarget | undefined {
  return ENCODE_PRESETS.find((p) => p.id === presetId)?.social;
}

export const ENCODE_PRESETS: readonly EncodePreset[] = [
  ...YOUTUBE_FAMILIES.flatMap((family) =>
    (family.hdr ? YOUTUBE_HDR : YOUTUBE_SDR).flatMap((row) =>
      FRAME_RATE_COLUMNS.map((column) => youtubePreset(family, row, column)),
    ),
  ),
  ...SOCIAL_FAMILIES.flatMap((family) => FRAME_RATE_COLUMNS.map((column) => socialPreset(family, column))),
  {
    id: 'archive',
    label: 'High quality archive',
    description: 'H.265 at twice the YouTube bitrate, 1 s GOP, original audio copied.',
    settings: (output) => ({
      codec: 'hevc',
      bitrateMbps: youtubeBitrateMbps(output) * 2,
      keyframeIntervalSeconds: 1,
      bFrames: 3,
      audio: 'copy',
      audioBitrateKbps: 384,
    }),
  },
  {
    id: 'editing',
    label: 'Editing friendly',
    description: 'Short 0.25 s GOP without B-frames for smooth scrubbing in video editors, H.264.',
    settings: (output) => ({
      codec: 'h264',
      bitrateMbps: youtubeBitrateMbps(output) * 3,
      keyframeIntervalSeconds: 0.25,
      bFrames: 0,
      audio: 'copy',
      audioBitrateKbps: 384,
    }),
  },
];

/** Whether a preset is one of the YouTube presets (including the ids of earlier versions). */
export function isYoutubePreset(presetId: string): boolean {
  return presetId === 'youtube' || presetId.startsWith('youtube-');
}

/**
 * Codec family of a YouTube preset id. Earlier versions had one preset per codec (`youtube` was
 * H.264), then one per codec and frame rate (`youtube-sdr-h264-60`).
 */
function youtubeFamilyOf(presetId: string): YoutubeFamily | undefined {
  const legacy: Record<string, string> = {
    youtube: 'youtube-sdr-h264',
    'youtube-hevc': 'youtube-sdr-hevc',
    'youtube-hdr': 'youtube-hdr-hevc',
  };
  const id = legacy[presetId] ?? presetId;
  return YOUTUBE_FAMILIES.find((family) => id === family.id || id.startsWith(`${family.id}-`));
}

/**
 * The YouTube preset of the same codec as `presetId` for an output: the nearest resolution row
 * and the frame rate's column, e.g. after the output was edited. Other presets are unchanged.
 */
export function youtubePresetForOutput(presetId: string, output: OutputSettings): string {
  const family = youtubeFamilyOf(presetId);
  if (!family) return presetId;
  const row = nearestRow(family.hdr ? YOUTUBE_HDR : YOUTUBE_SDR, output);
  const cls = frameRateClass(output.frameRate);
  const column = FRAME_RATE_COLUMNS.find((c) => c.cls === cls) ?? { suffix: '60' };
  return youtubeId(family, row.lines, column);
}

/** The YouTube preset suiting an output: HDR for HLG / PQ, HEVC for 10-bit SDR, H.264 otherwise. */
export function youtubePresetFor(output: OutputSettings): string {
  const family = isHdr(output)
    ? 'youtube-hdr-hevc'
    : output.color.bitDepth === 10
      ? 'youtube-sdr-hevc'
      : 'youtube-sdr-h264';
  return youtubePresetForOutput(family, output);
}

/** Notes of a preset on an output format (empty for unknown presets). */
export function presetNotes(presetId: string, output: OutputSettings): PresetNote[] {
  return ENCODE_PRESETS.find((p) => p.id === presetId)?.notes?.(output) ?? [];
}

/**
 * Encoder settings of a preset; ids of earlier YouTube presets map to the current ones, unknown
 * ids fall back to YouTube. Keeps the acceleration choice.
 */
export function encoderForPreset(
  presetId: string,
  output: OutputSettings,
  acceleration: EncoderSettings['acceleration'] = 'auto',
): EncoderSettings {
  const known = ENCODE_PRESETS.some((p) => p.id === presetId);
  const id = known
    ? presetId
    : youtubePresetForOutput(isYoutubePreset(presetId) ? presetId : 'youtube', output);
  const preset = ENCODE_PRESETS.find((p) => p.id === id) ?? ENCODE_PRESETS[0];
  if (!preset) throw new Error('No encode presets defined');
  return { preset: preset.id, ...preset.settings(output), acceleration };
}
