import type { VideoInfo } from '../media/probe.js';
import type { ResolvedDataRange } from '../model/data-range.js';
import type { ColorSettings, EncoderSettings, Project, Scaling, VideoRef } from '../model/project.js';
import { computeTimeline, enabledVideos, type ProjectMedia } from '../workflow/timeline.js';
import { fitFilters, rotatedSize, type ScaleRatio, sameAspect } from './canvas.js';

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

/** The GPU encoder family of each graphics card brand. */
export const GPU_ENCODER_FAMILIES = { nvidia: 'nvenc', amd: 'amf', intel: 'qsv' } as const;
export type GpuBrand = keyof typeof GPU_ENCODER_FAMILIES;

/**
 * Encoders to try for a codec, best first: GPU encoders (NVIDIA, AMD, Intel, or only the chosen
 * brand's), then the CPU one.
 */
export function encoderCandidates(
  codec: EncoderSettings['codec'],
  acceleration: EncoderSettings['acceleration'],
  bitDepth: 8 | 10,
): VideoEncoder[] {
  const software = SOFTWARE[codec];
  // GPU H.264 encoders are 8-bit only.
  if (acceleration === 'software' || (codec === 'h264' && bitDepth === 10)) return [software];
  const prefix = codec === 'h264' ? 'h264' : codec;
  const families =
    acceleration === 'auto' ? Object.values(GPU_ENCODER_FAMILIES) : [GPU_ENCODER_FAMILIES[acceleration]];
  const hardware = families.map((family) => ({
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

// --- GPU pipeline ------------------------------------------------------------------------------

/**
 * Where ffmpeg puts the widgets on the video: on the CPU, or on an NVIDIA graphics card (CUDA),
 * where the videos are scaled and the widgets blended without leaving the card's memory until
 * the encoder. The CPU blend of a 4K export is its slowest part.
 */
export type CompositePipeline = 'cpu' | 'cuda';

/** CUDA filters allocate frames in multiples of this many pixels (2160 rows take 2176). */
const CUDA_ALIGNMENT = 32;

const CUDA_SCALING: Record<Exclude<Scaling, 'fsr1'>, string> = {
  bilinear: 'bilinear',
  bicubic: 'bicubic',
  lanczos: 'lanczos',
};

/**
 * Why a video export cannot use the CUDA pipeline, or null when it can. The CUDA filters of
 * ffmpeg scale, change the range and blend 8-bit 4:2:0 frames, nothing more: every video must
 * fill the canvas as it is (no blur, turn, zoom, crop or bars) in the output's Rec.709 colours,
 * and the encoder must be NVIDIA's H.264 or HEVC one.
 */
export function cudaPipelineBlocker(options: {
  project: Project;
  media: ProjectMedia;
  encoder: VideoEncoder;
  dataRange?: ResolvedDataRange | null;
}): string | null {
  const { project, media, encoder } = options;
  const { output } = project;
  const { fit } = output;
  if (encoder.family !== 'nvenc') return 'the encoder is not an NVIDIA one';
  if (project.export.encoder.codec === 'av1') return 'AV1 cannot be cropped to the output size';
  if (output.color.bitDepth !== 8 || output.color.space !== 'rec709') return 'not 8-bit Rec.709';
  if (output.width % 2 !== 0 || output.height % 2 !== 0) return 'odd output size';
  if (project.export.scaling === 'fsr1') return 'FSR 1 sharpens on the CPU';
  if (fit.mode === 'blur' || fit.rotation !== 0 || fit.zoom !== 1) return 'the video placement';
  const { start, end } = exportRange(project, media, options.dataRange);
  for (const segment of exportSegments(project, media, start, end)) {
    if (segment.kind !== 'video') continue;
    const { info } = segment;
    if (info.color.space !== 'rec709') return `${info.fileName} is not Rec.709`;
    const shown = rotatedSize(info, info.rotation ?? 0);
    if (fit.mode !== 'stretch' && !sameAspect(shown, output))
      return `${info.fileName} does not fill the canvas`;
  }
  return null;
}

/** ffmpeg range name of a video's colours. */
const rangeOf = (color: ColorSettings) => (color.range === 'full' ? 'pc' : 'tv');

/**
 * Range ffmpeg decodes a video in, from its description of the file (`ffmpeg -i`): GoPro HEVC
 * says full range in the stream itself (`yuvj420p(pc, bt709)`), which the MP4 boxes do not show.
 * Without one, limited range, as ffmpeg's scaler assumes. Null when there is no video stream.
 */
export function parseDecodedRange(description: string): 'tv' | 'pc' | null {
  const video = description.split(/\r?\n/).find((line) => /Stream #.*Video:/.test(line));
  if (!video) return null;
  // The pixel format and its details come right before the frame size.
  const format = /,\s([a-z][a-z0-9_]*)(?:\(([^)]*)\))?,\s\d+x\d+/.exec(video);
  if (!format) return 'tv';
  const details = (format[2] ?? '').split(/,\s*/);
  return format[1]?.startsWith('yuvj') || details.includes('pc') ? 'pc' : 'tv';
}

/** Bitstream filter options cropping the rows and columns CUDA frames have past the output size. */
function cudaCrop(width: number, height: number): string {
  const align = (n: number) => Math.ceil(n / CUDA_ALIGNMENT) * CUDA_ALIGNMENT;
  const right = align(width) - width;
  const bottom = align(height) - height;
  return `${right ? `:crop_right=${right}` : ''}${bottom ? `:crop_bottom=${bottom}` : ''}`;
}

// --- ffmpeg command ---------------------------------------------------------------------------

export interface ExportCommand {
  /** ffmpeg arguments; the overlay frames go to stdin in `overlayFormat`. */
  args: string[];
  frames: number;
  width: number;
  height: number;
  frameRate: number;
  /** Audio as encoded: `copy` only works for a single uncut video piece. */
  audio: EncoderSettings['audio'];
  /** Pixels ffmpeg reads from stdin: premultiplied RGBA, or `yuva420p` for the CUDA pipeline. */
  overlayFormat: 'rgba' | 'yuva420p';
  pipeline: CompositePipeline;
}

const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6);

/**
 * Times frames by their number on a time base of one frame. ffmpeg's concat retimes the joined
 * pieces in microseconds, which can put the last frame just past the last widget frame, and the
 * blend (`shortest=1`) then drops it. Given to both the joined video and the widgets, frame n of
 * one meets frame n of the other.
 */
const frameIndexTimes = (rate: string) => `settb=1/${rate},setpts=N`;

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
  /** `cuda` only when `cudaPipelineBlocker` allows it; the CPU by default. */
  pipeline?: CompositePipeline;
  /**
   * Range each video file (by path) decodes in (see `parseDecodedRange`), for the CUDA pipeline,
   * which must be told: the probed `info.color` is used for the files missing here.
   */
  videoRanges?: Readonly<Record<string, 'tv' | 'pc'>>;
}): ExportCommand {
  if (options.pipeline === 'cuda') return cudaExportCommand(options);
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
  const { audio, encodeAudio } = exportAudio(project, segments);

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
    if (encodeAudio) {
      if (!sound) {
        inputs.push('-f', 'lavfi', '-t', duration, '-i', 'anullsrc=r=48000:cl=stereo');
        sound = `${index}:a:0`;
        index++;
      }
      filters.push(
        `[${sound}]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${k}]`,
      );
    }
    concat.push(`[v${k}]`, ...(encodeAudio ? [`[a${k}]`] : []));
  }
  const overlayIndex = index;
  // Overlay frames: Skia's premultiplied RGBA.
  inputs.push('-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', rate, '-i', 'pipe:0');

  filters.push(
    `${concat.join('')}concat=n=${segments.length}:v=1:a=${encodeAudio ? 1 : 0}[joined]${encodeAudio ? '[aout]' : ''}`,
    `[joined]${frameIndexTimes(rate)}[base]`,
    // The widgets' RGB is converted with the output's matrix and range: left to the overlay filter
    // it would use BT.601 on an HD video and shift colours (#ff5a36 came out #fc7139).
    `[${overlayIndex}:v:0]${frameIndexTimes(rate)},unpremultiply=inplace=1,scale=out_color_matrix=${color.matrix}:out_range=${color.range},format=${blend.overlay}[widgets]`,
    `[base][widgets]overlay=0:0:format=${blend.format}:shortest=1,format=${pixelFormat}[vout]`,
  );

  const args = outputArgs({
    project,
    encoder,
    inputs,
    filters,
    frames,
    audio,
    encodeAudio,
    bitstreamFilter: color.bitstreamFilter,
    outputPath,
  });
  return { args, frames, width, height, frameRate, audio, overlayFormat: 'rgba', pipeline: 'cpu' };
}

/** Whether and how the export has sound: `copy` only works for a single uncut video piece. */
function exportAudio(project: Project, segments: ExportSegment[]) {
  const settings = project.export.encoder;
  const single = segments.length === 1 && segments[0]?.kind === 'video' && segments[0].info.hasAudio;
  const audio: EncoderSettings['audio'] = settings.audio === 'copy' && !single ? 'aac' : settings.audio;
  return { audio, encodeAudio: audio !== 'none' && audio !== 'copy' };
}

/** The whole ffmpeg command around its inputs and filter graph (which ends in `[vout]`). */
function outputArgs(options: {
  project: Project;
  encoder: VideoEncoder;
  inputs: string[];
  filters: string[];
  frames: number;
  audio: EncoderSettings['audio'];
  encodeAudio: boolean;
  bitstreamFilter: string;
  outputPath: string;
}): string[] {
  const { project, encoder, audio } = options;
  const { output } = project;
  const settings = project.export.encoder;
  const color = colorArgs(output.color, settings.codec);
  const maps = ['-map', '[vout]'];
  const audioArgs: string[] = [];
  if (audio === 'copy') {
    maps.push('-map', '0:a:0');
    audioArgs.push('-c:a', 'copy');
  } else if (options.encodeAudio) {
    maps.push('-map', '[aout]');
    audioArgs.push('-c:a', 'aac', '-b:a', `${settings.audioBitrateKbps}k`);
  }
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    ...options.inputs,
    '-filter_complex',
    options.filters.join(';'),
    ...maps,
    '-frames:v',
    String(options.frames),
    ...encoderArgs(encoder, { ...settings, audio }, output.frameRate, output.color.bitDepth),
    ...color.tags,
    '-bsf:v',
    options.bitstreamFilter,
    '-r',
    fmt(output.frameRate),
    ...audioArgs,
    ...(audio === 'none' ? ['-an'] : []),
    // Fast start rewrites the whole file once it is done: skipped for a slow disk.
    ...(project.export.disk?.slow ? [] : ['-movflags', '+faststart']),
    options.outputPath,
  ];
}

/**
 * The CUDA pipeline: each piece decoded on the GPU (to memory, so ffmpeg still applies the file's
 * rotation), uploaded, converted to the output range and scaled to the canvas on the GPU, the
 * pieces joined, and the widgets (`yuva420p` from stdin, converted by the drawing threads)
 * blended on top with `overlay_cuda`. That filter hands on frames of the GPU's allocated size,
 * past the output size: the encoder keeps them and the bitstream filter crops the stream to the
 * output size, so nothing is scaled (scaling them would squash the picture over green rows).
 */
function cudaExportCommand(options: {
  project: Project;
  media: ProjectMedia;
  outputPath: string;
  encoder: VideoEncoder;
  dataRange?: ResolvedDataRange | null;
  videoRanges?: Readonly<Record<string, 'tv' | 'pc'>>;
}): ExportCommand {
  const { project, media, outputPath, encoder } = options;
  const { output } = project;
  const { width, height, frameRate } = output;
  const { start, end } = exportRange(project, media, options.dataRange);
  const frames = exportFrameCount(start, end, frameRate);
  const segments = exportSegments(project, media, start, end);
  const color = colorArgs(output.color, project.export.encoder.codec);
  const { audio, encodeAudio } = exportAudio(project, segments);
  const rate = fmt(frameRate);
  const scaling = project.export.scaling === 'fsr1' ? 'lanczos' : project.export.scaling;
  // Ranges are set on every piece: colorspace_cuda takes frames without one for full range,
  // where ffmpeg's scaler (the CPU pipeline) takes them for limited range.
  const toCanvas = (range: string) =>
    [
      `setparams=range=${range}`,
      'hwupload_cuda',
      `colorspace_cuda=range=${color.range}`,
      `scale_cuda=w=${width}:h=${height}:interp_algo=${CUDA_SCALING[scaling]}:format=yuv420p`,
      'setpts=PTS-STARTPTS',
    ].join(',');

  const inputs: string[] = [];
  const filters: string[] = [];
  const concat: string[] = [];
  let index = 0;
  for (const [k, segment] of segments.entries()) {
    const duration = fmt(segment.duration);
    let sound: string | null = null;
    if (segment.kind === 'video') {
      inputs.push('-hwaccel', 'cuda', '-ss', fmt(segment.from), '-t', duration, '-i', segment.info.path);
      // Frame rate first: a 120 fps camera exported at 60 fps uploads half the frames.
      const range = options.videoRanges?.[segment.info.path] ?? rangeOf(segment.info.color);
      filters.push(`[${index}:v:0]fps=${rate},${toCanvas(range)}[v${k}]`);
      if (segment.info.hasAudio) sound = `${index}:a:0`;
    } else {
      inputs.push('-f', 'lavfi', '-t', duration, '-i', `color=c=black:s=${width}x${height}:r=${rate}`);
      filters.push(`[${index}:v:0]${toCanvas('tv')}[v${k}]`);
    }
    index++;
    if (encodeAudio) {
      if (!sound) {
        inputs.push('-f', 'lavfi', '-t', duration, '-i', 'anullsrc=r=48000:cl=stereo');
        sound = `${index}:a:0`;
        index++;
      }
      filters.push(
        `[${sound}]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${k}]`,
      );
    }
    concat.push(`[v${k}]`, ...(encodeAudio ? [`[a${k}]`] : []));
  }
  const overlayIndex = index;
  inputs.push(
    '-f',
    'rawvideo',
    '-pix_fmt',
    'yuva420p',
    '-s',
    `${width}x${height}`,
    '-r',
    rate,
    '-i',
    'pipe:0',
  );
  filters.push(
    `${concat.join('')}concat=n=${segments.length}:v=1:a=${encodeAudio ? 1 : 0}[joined]${encodeAudio ? '[aout]' : ''}`,
    `[joined]${frameIndexTimes(rate)}[base]`,
    `[${overlayIndex}:v:0]${frameIndexTimes(rate)},hwupload_cuda[widgets]`,
    '[base][widgets]overlay_cuda=0:0:shortest=1[vout]',
  );
  const args = outputArgs({
    project,
    encoder,
    inputs,
    filters,
    frames,
    audio,
    encodeAudio,
    bitstreamFilter: `${color.bitstreamFilter}${cudaCrop(width, height)}`,
    outputPath,
  });
  return { args, frames, width, height, frameRate, audio, overlayFormat: 'yuva420p', pipeline: 'cuda' };
}

/** A video export drawn frame by frame (the web app): the frames and the pieces they come from. */
export interface VideoExportPlan extends ImageSequencePlan {
  segments: ExportSegment[];
}

/** Frames and pieces of a video export, for exporters without ffmpeg. */
export function videoExportPlan(
  project: Project,
  media: ProjectMedia,
  dataRange: ResolvedDataRange | null = null,
): VideoExportPlan {
  const plan = imageSequencePlan(project, media, dataRange);
  const end = plan.start + plan.frames / plan.frameRate;
  return { ...plan, segments: exportSegments(project, media, plan.start, end) };
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
  return { args, frames, width, height, frameRate, audio: 'none', overlayFormat: 'rgba', pipeline: 'cpu' };
}
