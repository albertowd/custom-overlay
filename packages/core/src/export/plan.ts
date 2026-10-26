import type { VideoInfo } from '../media/probe.js';
import type { ResolvedDataRange } from '../model/data-range.js';
import type { ColorSettings, EncoderSettings, Project, Scaling, VideoRef } from '../model/project.js';
import { computeTimeline, enabledVideos, type ProjectMedia } from '../workflow/timeline.js';
import { fitFilters, type ScaleRatio } from './canvas.js';

/** A piece of the export: a part of one video, or a gap without video (black, silent). */
export type ExportSegment =
  | {
      kind: 'video';
      video: VideoRef;
      info: VideoInfo /** Video time it starts at. */;
      from: number;
      duration: number;
    }
  | { kind: 'gap'; duration: number };

/**
 * Where open export bounds go: the data range set in the Track step, inside the timeline, or the
 * whole timeline without one (or when it misses the timeline).
 */
export function defaultExportRange(
  timeline: { start: number; end: number },
  dataRange: ResolvedDataRange | null,
): { start: number; end: number } {
  if (!dataRange) return { start: timeline.start, end: timeline.end };
  const start = Math.max(timeline.start, dataRange.start);
  const end = Math.min(timeline.end, dataRange.end);
  return end > start ? { start, end } : { start: timeline.start, end: timeline.end };
}

/** Timeline seconds to export: the export range, open bounds following `defaultExportRange`. */
export function exportRange(
  project: Project,
  media: ProjectMedia,
  dataRange: ResolvedDataRange | null = null,
): { start: number; end: number } {
  const fallback = defaultExportRange(computeTimeline(project, media), dataRange);
  const start = project.export.range.start ?? fallback.start;
  const end = project.export.range.end ?? fallback.end;
  return { start, end: Math.max(start, end) };
}

/** Frames of a range at a frame rate. */
export function exportFrameCount(start: number, end: number, frameRate: number): number {
  return Math.max(0, Math.round((end - start) * frameRate));
}

/**
 * Approximate size in bytes of a video export lasting `seconds`: the target video bitrate plus
 * the audio (copied audio is counted at the AAC bitrate), and ~0.5 % of MP4 overhead.
 */
export function estimateExportBytes(encoder: EncoderSettings, seconds: number): number {
  const audioKbps = encoder.audio === 'none' ? 0 : encoder.audioBitrateKbps;
  const bitsPerSecond = encoder.bitrateMbps * 1e6 + audioKbps * 1e3;
  return Math.max(0, seconds) * (bitsPerSecond / 8) * 1.005;
}

/**
 * The videos and gaps covering a range, in order. Where videos overlap the first enabled video
 * wins, like the preview. Pieces shorter than a millisecond are dropped.
 */
export function exportSegments(
  project: Project,
  media: ProjectMedia,
  start: number,
  end: number,
): ExportSegment[] {
  const videos = enabledVideos(project).flatMap((video) => {
    const info = media.videos[video.id];
    return info
      ? [{ video, info, from: video.offsetSeconds, to: video.offsetSeconds + info.durationSeconds }]
      : [];
  });
  const segments: ExportSegment[] = [];
  const push = (segment: ExportSegment) => {
    if (segment.duration < 1e-3) return;
    const last = segments[segments.length - 1];
    if (segment.kind === 'gap' && last?.kind === 'gap') last.duration += segment.duration;
    else segments.push(segment);
  };
  let t = start;
  while (t < end - 1e-6) {
    const covering = videos.find((v) => v.from <= t + 1e-9 && t < v.to - 1e-9);
    if (covering) {
      // Until this video ends or an earlier-listed video takes over.
      let until = Math.min(end, covering.to);
      for (const other of videos) {
        if (other === covering) break;
        if (other.from > t && other.from < until) until = other.from;
      }
      push({
        kind: 'video',
        video: covering.video,
        info: covering.info,
        from: t - covering.from,
        duration: until - t,
      });
      t = until;
    } else {
      const next = Math.min(end, ...videos.filter((v) => v.from > t).map((v) => v.from));
      push({ kind: 'gap', duration: next - t });
      t = next;
    }
  }
  return segments;
}

// --- Encoders ---------------------------------------------------------------------------------

export type EncoderFamily = 'x264' | 'x265' | 'aom' | 'nvenc' | 'amf' | 'qsv';

/** An ffmpeg video encoder. */
export interface VideoEncoder {
  /** ffmpeg encoder name, e.g. `libx264` or `hevc_amf`. */
  name: string;
  family: EncoderFamily;
  hardware: boolean;
}

const SOFTWARE: Record<EncoderSettings['codec'], VideoEncoder> = {
  h264: { name: 'libx264', family: 'x264', hardware: false },
  hevc: { name: 'libx265', family: 'x265', hardware: false },
  av1: { name: 'libaom-av1', family: 'aom', hardware: false },
};

/** Encoders to try for a codec, best first: GPU encoders (NVIDIA, AMD, Intel), then the CPU one. */
export function encoderCandidates(
  codec: EncoderSettings['codec'],
  acceleration: EncoderSettings['acceleration'],
  bitDepth: 8 | 10,
): VideoEncoder[] {
  const software = SOFTWARE[codec];
  // GPU H.264 encoders are 8-bit only.
  if (acceleration === 'software' || (codec === 'h264' && bitDepth === 10)) return [software];
  const prefix = codec === 'h264' ? 'h264' : codec;
  const hardware = (['nvenc', 'amf', 'qsv'] as const).map((family) => ({
    name: `${prefix}_${family}`,
    family,
    hardware: true,
  }));
  return [...hardware, software];
}

/** ffmpeg arguments of a video encoder for the encoder settings. */
export function encoderArgs(
  encoder: VideoEncoder,
  settings: EncoderSettings,
  frameRate: number,
  bitDepth: 8 | 10,
): string[] {
  const gop = Math.max(1, Math.round(settings.keyframeIntervalSeconds * frameRate));
  const rate = (factor: number) => `${Math.round(settings.bitrateMbps * factor * 1000)}k`;
  const bitrate = ['-b:v', rate(1), '-maxrate', rate(1.5), '-bufsize', rate(2)];
  const hevcTag = settings.codec === 'hevc' ? ['-tag:v', 'hvc1'] : [];
  const args = ['-c:v', encoder.name];
  switch (encoder.family) {
    case 'x264':
      args.push('-preset', 'medium', '-profile:v', bitDepth === 10 ? 'high10' : 'high', ...bitrate);
      args.push('-g', String(gop), '-keyint_min', String(gop), '-bf', String(settings.bFrames));
      args.push('-sc_threshold', '0', '-flags', '+cgop');
      break;
    case 'x265':
      args.push('-preset', 'medium', ...bitrate);
      args.push(
        '-x265-params',
        `keyint=${gop}:min-keyint=${gop}:bframes=${settings.bFrames}:no-open-gop=1:scenecut=0:log-level=error`,
      );
      break;
    case 'aom':
      args.push('-cpu-used', '6', '-row-mt', '1', ...bitrate, '-g', String(gop));
      break;
    case 'nvenc':
      args.push(
        '-preset',
        'p5',
        '-rc',
        'vbr',
        ...bitrate,
        '-g',
        String(gop),
        '-bf',
        String(settings.bFrames),
      );
      break;
    case 'amf':
      // B-frame support varies between AMD GPUs: left to the driver.
      args.push(
        '-usage',
        'transcoding',
        '-quality',
        'quality',
        '-rc',
        'vbr_peak',
        ...bitrate,
        '-g',
        String(gop),
      );
      break;
    case 'qsv':
      args.push('-preset', 'medium', ...bitrate, '-g', String(gop), '-bf', String(settings.bFrames));
      break;
  }
  return [...args, ...hevcTag];
}

/** Pixel format the encoder receives. */
export function encoderPixelFormat(encoder: VideoEncoder, bitDepth: 8 | 10): string {
  if (bitDepth === 8) return 'yuv420p';
  return encoder.hardware ? 'p010le' : 'yuv420p10le';
}

/**
 * ffmpeg colour tags, the scaler's output range / matrix, and a bitstream filter writing the
 * same colour description (H.273 codes) into the stream: some GPU encoders ignore the tags.
 */
export function colorArgs(
  color: ColorSettings,
  codec: EncoderSettings['codec'],
): {
  tags: string[];
  range: 'tv' | 'pc';
  matrix: 'bt709' | 'bt2020';
  bitstreamFilter: string;
} {
  const bt2020 = color.space !== 'rec709';
  const transfer =
    color.space === 'rec2020-hlg' ? 'arib-std-b67' : color.space === 'rec2020-pq' ? 'smpte2084' : 'bt709';
  const range = color.range === 'full' ? 'pc' : 'tv';
  const primaries = bt2020 ? 9 : 1;
  const trc = color.space === 'rec2020-hlg' ? 18 : color.space === 'rec2020-pq' ? 16 : 1;
  const coefficients = bt2020 ? 9 : 1;
  const bitstreamFilter =
    codec === 'av1'
      ? `av1_metadata=color_primaries=${primaries}:transfer_characteristics=${trc}:matrix_coefficients=${coefficients}:color_range=${range}`
      : `${codec === 'h264' ? 'h264' : 'hevc'}_metadata=colour_primaries=${primaries}:transfer_characteristics=${trc}:matrix_coefficients=${coefficients}:video_full_range_flag=${range === 'pc' ? 1 : 0}`;
  return {
    bitstreamFilter,
    tags: [
      '-color_primaries',
      bt2020 ? 'bt2020' : 'bt709',
      '-color_trc',
      transfer,
      '-colorspace',
      bt2020 ? 'bt2020nc' : 'bt709',
      '-color_range',
      range,
    ],
    range,
    matrix: bt2020 ? 'bt2020' : 'bt709',
  };
}

/**
 * Scale filter of the videos, converting to the output's range and matrix; FSR 1 is approximated
 * by Lanczos followed by AMD's CAS sharpening (`cas`).
 */
function videoScaler(
  scaling: Scaling,
  range: string,
  matrix: string,
): { scale(width: string, height: string, ratio: ScaleRatio): string; sharpen: string[] } {
  const flags = scaling === 'fsr1' ? 'lanczos' : scaling;
  return {
    scale: (width, height, ratio) =>
      `scale=${width}:${height}:flags=${flags}${ratio === 'disable' ? '' : `:force_original_aspect_ratio=${ratio}:force_divisible_by=2`}:out_range=${range}:out_color_matrix=${matrix}`,
    sharpen: scaling === 'fsr1' ? ['cas=strength=0.4'] : [],
  };
}

// --- ffmpeg command ---------------------------------------------------------------------------

export interface ExportCommand {
  /** ffmpeg arguments; the overlay frames go to stdin as raw RGBA. */
  args: string[];
  frames: number;
  width: number;
  height: number;
  frameRate: number;
  /** Audio as encoded: `copy` only works for a single uncut video piece. */
  audio: EncoderSettings['audio'];
}

const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6);

/**
 * ffmpeg command of a video export: the pieces of the range (videos cut with `-ss`/`-t`, gaps
 * as black and silence), scaled to the output, concatenated, with the overlay frames from stdin
 * on top, then encoded.
 */
export function videoExportCommand(options: {
  project: Project;
  media: ProjectMedia;
  outputPath: string;
  encoder: VideoEncoder;
  /** ffmpeg `-hwaccel` method to decode the videos on the GPU (`d3d11va`, `auto`...), null for the CPU. */
  hardwareDecode: string | null;
  /** Resolved data range, where open range bounds go (see `defaultExportRange`). */
  dataRange?: ResolvedDataRange | null;
}): ExportCommand {
  const { project, media, outputPath, encoder } = options;
  const { output } = project;
  const settings = project.export.encoder;
  const { width, height, frameRate } = output;
  const { start, end } = exportRange(project, media, options.dataRange);
  const frames = exportFrameCount(start, end, frameRate);
  const segments = exportSegments(project, media, start, end);
  const color = colorArgs(output.color, settings.codec);
  const pixelFormat = encoderPixelFormat(encoder, output.color.bitDepth);
  // Blended at full chroma resolution so thin widget edges keep their colour, then subsampled once.
  const blend =
    output.color.bitDepth === 10
      ? { base: 'yuv444p10le', overlay: 'yuva444p10le', format: 'yuv444p10' }
      : { base: 'yuv444p', overlay: 'yuva444p', format: 'yuv444' };
  const withAudio = settings.audio !== 'none';
  // Stream copy needs the audio of one file, untouched by filters.
  const single = segments.length === 1 && segments[0]?.kind === 'video' && segments[0].info.hasAudio;
  const audio: EncoderSettings['audio'] = settings.audio === 'copy' && !single ? 'aac' : settings.audio;

  const inputs: string[] = [];
  const filters: string[] = [];
  const concat: string[] = [];
  let index = 0;
  const rate = fmt(frameRate);
  const scaler = videoScaler(project.export.scaling, color.range, color.matrix);
  for (const [k, segment] of segments.entries()) {
    const duration = fmt(segment.duration);
    let video: string;
    let sound: string | null = null;
    if (segment.kind === 'video') {
      if (options.hardwareDecode) inputs.push('-hwaccel', options.hardwareDecode);
      inputs.push('-ss', fmt(segment.from), '-t', duration, '-i', segment.info.path);
      video = `${index}:v:0`;
      if (segment.info.hasAudio) sound = `${index}:a:0`;
      index++;
    } else {
      inputs.push('-f', 'lavfi', '-t', duration, '-i', `color=c=black:s=${width}x${height}:r=${rate}`);
      video = `${index}:v:0`;
      index++;
    }
    filters.push(
      ...fitFilters({
        input: `[${video}]`,
        output: `[v${k}]`,
        id: `f${k}`,
        width,
        height,
        // Gaps are black frames of the canvas size already.
        fit:
          segment.kind === 'video'
            ? output.fit
            : { mode: 'contain', rotation: 0, rotateWidgets: false, zoom: 1, x: 0.5, y: 0.5 },
        ...scaler,
        planarFormat: blend.base,
        // Frame rate first: a 120 fps camera exported at 60 fps scales half the frames.
        before: [`fps=${rate}`],
        after: ['setpts=PTS-STARTPTS', `format=${blend.base}`],
      }),
    );
    if (withAudio && audio !== 'copy') {
      if (!sound) {
        inputs.push('-f', 'lavfi', '-t', duration, '-i', 'anullsrc=r=48000:cl=stereo');
        sound = `${index}:a:0`;
        index++;
      }
      filters.push(
        `[${sound}]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${k}]`,
      );
    }
    concat.push(`[v${k}]`, ...(withAudio && audio !== 'copy' ? [`[a${k}]`] : []));
  }
  const overlayIndex = index;
  // Overlay frames: Skia's premultiplied RGBA.
  inputs.push('-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', rate, '-i', 'pipe:0');

  const encodeAudio = withAudio && audio !== 'copy';
  filters.push(
    `${concat.join('')}concat=n=${segments.length}:v=1:a=${encodeAudio ? 1 : 0}[base]${encodeAudio ? '[aout]' : ''}`,
    // The widgets' RGB is converted with the output's matrix and range: left to the overlay filter
    // it would use BT.601 on an HD video and shift colours (#ff5a36 came out #fc7139).
    `[${overlayIndex}:v:0]unpremultiply=inplace=1,scale=out_color_matrix=${color.matrix}:out_range=${color.range},format=${blend.overlay}[widgets]`,
    `[base][widgets]overlay=0:0:format=${blend.format}:shortest=1,format=${pixelFormat}[vout]`,
  );

  const maps = ['-map', '[vout]'];
  const audioArgs: string[] = [];
  if (audio === 'copy') {
    maps.push('-map', '0:a:0');
    audioArgs.push('-c:a', 'copy');
  } else if (encodeAudio) {
    maps.push('-map', '[aout]');
    audioArgs.push('-c:a', 'aac', '-b:a', `${settings.audioBitrateKbps}k`);
  }

  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    ...inputs,
    '-filter_complex',
    filters.join(';'),
    ...maps,
    '-frames:v',
    String(frames),
    ...encoderArgs(encoder, { ...settings, audio }, frameRate, output.color.bitDepth),
    ...color.tags,
    '-bsf:v',
    color.bitstreamFilter,
    '-r',
    rate,
    ...audioArgs,
    ...(audio === 'none' ? ['-an'] : []),
    '-movflags',
    '+faststart',
    outputPath,
  ];
  return { args, frames, width, height, frameRate, audio };
}

/** Frames of a transparent PNG sequence: the output size and rate over the export range. */
export interface ImageSequencePlan {
  width: number;
  height: number;
  frameRate: number;
  /** Timeline time of frame 0. */
  start: number;
  frames: number;
}

export function imageSequencePlan(
  project: Project,
  media: ProjectMedia,
  dataRange: ResolvedDataRange | null = null,
): ImageSequencePlan {
  const { width, height, frameRate } = project.output;
  const { start, end } = exportRange(project, media, dataRange);
  return { width, height, frameRate, start, frames: exportFrameCount(start, end, frameRate) };
}

/** Name of frame `n` of an image sequence (what ffmpeg writes for `frame_%06d.png`). */
export function sequenceFrameName(n: number): string {
  return `frame_${String(n).padStart(6, '0')}.png`;
}

/** ffmpeg command of a transparent PNG sequence: the overlay frames only. */
export function imageSequenceCommand(options: {
  project: Project;
  media: ProjectMedia;
  /** Output file pattern, e.g. `C:/out/frame_%06d.png`. */
  pattern: string;
  dataRange?: ResolvedDataRange | null;
}): ExportCommand {
  const { project, media, pattern } = options;
  const { width, height, frameRate, frames } = imageSequencePlan(project, media, options.dataRange);
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    `${width}x${height}`,
    '-r',
    fmt(frameRate),
    '-i',
    'pipe:0',
    // Skia pixels are premultiplied; PNG stores straight alpha.
    '-vf',
    'unpremultiply=inplace=1',
    '-frames:v',
    String(frames),
    '-c:v',
    'png',
    '-pix_fmt',
    'rgba',
    '-start_number',
    '0',
    '-f',
    'image2',
    pattern,
  ];
  return { args, frames, width, height, frameRate, audio: 'none' };
}
