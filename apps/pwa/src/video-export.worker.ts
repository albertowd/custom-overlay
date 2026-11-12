import type { ExportSegment, VideoRotation } from '@custom-overlay/core';
import type { ExportProgress } from '@custom-overlay/core/node';
import {
  ALL_FORMATS,
  type AudioCodec,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  CanvasSource,
  canEncodeAudio,
  canEncodeVideo,
  Input,
  type InputAudioTrack,
  type InputVideoTrack,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  type StreamTargetChunk,
  type VideoCodec,
  VideoSampleSink,
} from 'mediabunny';
import { planar, SAMPLE_RATE, StereoResampler, toStereo } from './audio-convert';
import { type DrawnFrame, FramePool } from './frame-pool';
import {
  BROWSER_CODECS,
  backdropBlur,
  backdropPlacement,
  backdropSize,
  drawPlaced,
  type FramePlacement,
  framePlacement,
  pieceFrames,
} from './video-compose';
import type {
  VideoJob,
  VideoJobResult,
  VideoTarget,
  VideoWorkerRequest,
  VideoWorkerResponse,
} from './video-export-protocol';

/**
 * The web app's video export, in a worker: the videos are decoded and the output encoded with the
 * browser's WebCodecs (on the device's hardware when it can), each frame put together on a canvas:
 * the video placed like the desktop export does it, the widgets drawn by the drawing workers on
 * top. The MP4 is written as it goes, so its size is only limited by the disk.
 */

/** Audio channels of the output (48 kHz), like the desktop export. */
const CHANNELS = 2;
/** Audio is kept this many seconds ahead of the video, so the MP4 writer holds little. */
const AUDIO_LEAD = 1;
const SILENCE_SECONDS = 0.1;

class Cancelled extends Error {
  constructor() {
    super('Export cancelled');
  }
}

let cancelled = false;
const check = () => {
  if (cancelled) throw new Cancelled();
};

const reply = (response: VideoWorkerResponse) => postMessage(response);

/** Where the MP4 goes, as a stream of positioned writes, and how to remove it after a failure. */
async function openTarget(
  target: VideoTarget,
): Promise<{ writable: WritableStream<StreamTargetChunk>; discard(): Promise<void> }> {
  if (target.kind === 'file') {
    const stream = await target.handle.createWritable();
    return {
      // It takes `{ type: 'write', position, data }` chunks, as the MP4 writer gives them.
      writable: stream as unknown as WritableStream<StreamTargetChunk>,
      async discard() {
        await stream.abort().catch(() => undefined);
        // The picker created the file: an unfinished export leaves nothing.
        await (target.handle as { remove?(): Promise<void> }).remove?.().catch(() => undefined);
      },
    };
  }
  const root = await navigator.storage.getDirectory();
  const folder = await root.getDirectoryHandle('exports', { create: true });
  const file = (await folder.getFileHandle(target.name, { create: true })) as FileSystemFileHandle & {
    // Worker only, missing from the DOM types.
    createSyncAccessHandle(): Promise<SyncAccessHandle>;
  };
  const access = await file.createSyncAccessHandle();
  access.truncate(0);
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    access.flush();
    access.close();
  };
  return {
    writable: new WritableStream<StreamTargetChunk>({
      write(chunk) {
        access.write(chunk.data, { at: chunk.position });
      },
      close,
      abort: close,
    }),
    async discard() {
      close();
      await folder.removeEntry(target.name).catch(() => undefined);
    },
  };
}

/** Synchronous writes to a file of the private storage (workers only). */
interface SyncAccessHandle {
  write(data: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

/** A video file opened for decoding. */
interface OpenedVideo {
  input: Input;
  video: InputVideoTrack;
  frames: VideoSampleSink;
  audio: AudioSampleSink | null;
}

async function chooseVideoCodec(
  wanted: VideoCodec,
  options: { width: number; height: number; bitrate: number },
  warnings: Set<string>,
): Promise<VideoCodec> {
  for (const codec of [...new Set<VideoCodec>([wanted, 'avc'])]) {
    if (await canEncodeVideo(codec, options)) {
      if (codec !== wanted)
        warnings.add(`This browser cannot encode ${wanted.toUpperCase()}: encoded as H.264`);
      return codec;
    }
  }
  throw new Error(`This browser cannot encode video at ${options.width} x ${options.height}`);
}

async function chooseAudioCodec(bitrate: number, warnings: Set<string>): Promise<AudioCodec | null> {
  const options = { numberOfChannels: CHANNELS, sampleRate: SAMPLE_RATE, bitrate };
  if (await canEncodeAudio('aac', options)) return 'aac';
  if (await canEncodeAudio('opus', options)) {
    warnings.add('This browser cannot encode AAC audio: encoded as Opus');
    return 'opus';
  }
  warnings.add('This browser cannot encode audio: exported without sound');
  return null;
}

/** Stereo 48 kHz audio at an output time. */
function stereoSample(left: Float32Array, right: Float32Array, timestamp: number): AudioSample {
  return new AudioSample({
    data: planar(left, right),
    format: 'f32-planar',
    numberOfChannels: CHANNELS,
    sampleRate: SAMPLE_RATE,
    timestamp,
  });
}

/** Silence of `frames` frames (48 kHz) from an output time, in short samples. */
function* silence(timestamp: number, frames: number): Generator<AudioSample> {
  const chunk = Math.round(SILENCE_SECONDS * SAMPLE_RATE);
  for (let done = 0; done < frames; done += chunk) {
    const length = Math.min(chunk, frames - done);
    const zeros = new Float32Array(length);
    yield stereoSample(zeros, zeros, timestamp + done / SAMPLE_RATE);
  }
}

/** The planes of an audio sample as 32-bit floats. */
function planesOf(sample: AudioSample): Float32Array[] {
  return Array.from({ length: Math.min(sample.numberOfChannels, CHANNELS) }, (_, planeIndex) => {
    const plane = new Float32Array(sample.numberOfFrames);
    sample.copyTo(plane, { planeIndex, format: 'f32-planar' });
    return plane;
  });
}

/**
 * The output's audio in order, 48 kHz stereo: each video piece's sound cut to the piece (silence
 * where it has none or runs short), silence for gaps. Timestamps count the frames given so far,
 * so the track has no holes.
 */
async function* audioSamples(
  segments: readonly ExportSegment[],
  open: (segment: Extract<ExportSegment, { kind: 'video' }>) => Promise<OpenedVideo>,
): AsyncGenerator<AudioSample> {
  /** Output frames given so far, and the output frame each piece ends at. */
  let given = 0;
  let pieceEnd = 0;
  for (const segment of segments) {
    const pieceStart = pieceEnd;
    pieceEnd += segment.duration;
    const endFrame = Math.round(pieceEnd * SAMPLE_RATE);
    const audio = segment.kind === 'video' ? (await open(segment)).audio : null;
    if (audio && segment.kind === 'video') {
      const from = segment.from;
      const to = segment.from + segment.duration;
      let resampler: StereoResampler | null = null;
      for await (const sample of audio.samples(from, to)) {
        const rate = sample.sampleRate;
        const first = Math.max(0, Math.round((from - sample.timestamp) * rate));
        const last = Math.min(sample.numberOfFrames, Math.round((to - sample.timestamp) * rate));
        if (last <= first) {
          sample.close();
          continue;
        }
        const part = first > 0 || last < sample.numberOfFrames ? sample.trim(first, last) : sample;
        // Where it belongs in the output; a hole in the sound before it is filled with silence.
        const due = Math.round((pieceStart + (part.timestamp - from)) * SAMPLE_RATE);
        if (due - given > SAMPLE_RATE / 100) {
          yield* silence(given / SAMPLE_RATE, Math.min(due, endFrame) - given);
          given = Math.min(due, endFrame);
          resampler = null;
        }
        if (resampler?.inputRate !== rate) resampler = new StereoResampler(rate);
        const [left, right] = resampler.push(...toStereo(planesOf(part)));
        if (part !== sample) part.close();
        sample.close();
        const length = Math.min(left.length, endFrame - given);
        if (length <= 0) continue;
        yield stereoSample(left.subarray(0, length), right.subarray(0, length), given / SAMPLE_RATE);
        given += length;
      }
    }
    if (endFrame > given) {
      yield* silence(given / SAMPLE_RATE, endFrame - given);
      given = endFrame;
    }
  }
}

async function run(job: VideoJob, onProgress: (progress: ExportProgress) => void): Promise<VideoJobResult> {
  const started = performance.now();
  const { plan, fit, encoder } = job;
  const { width, height, frameRate, frames } = plan;
  if (frames === 0) throw new Error('The export range is empty');
  const warnings = new Set<string>();
  const { color } = job.overlay.project.output;
  if (color.bitDepth === 10 || color.space !== 'rec709') {
    warnings.add('Browsers encode 8-bit SDR only: exported as 8-bit Rec.709');
  }
  const bitrate = encoder.bitrateMbps * 1e6;
  const hardwareAcceleration =
    encoder.acceleration === 'software'
      ? 'prefer-software'
      : encoder.acceleration === 'auto'
        ? 'no-preference'
        : 'prefer-hardware';
  const videoCodec = await chooseVideoCodec(
    BROWSER_CODECS[encoder.codec],
    { width, height, bitrate },
    warnings,
  );
  const audioBitrate = encoder.audioBitrateKbps * 1000;
  const audioCodec = encoder.audio === 'none' ? null : await chooseAudioCodec(audioBitrate, warnings);
  if (encoder.audio === 'copy') warnings.add('The browser re-encodes the audio instead of copying it');

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D;
  ctx.imageSmoothingQuality = 'high';
  const small = backdropSize({ width, height });
  const backdrop = new OffscreenCanvas(small.width, small.height);
  const backdropCtx = backdrop.getContext('2d') as OffscreenCanvasRenderingContext2D;
  const blurred = new OffscreenCanvas(small.width, small.height);
  const blurredCtx = blurred.getContext('2d') as OffscreenCanvasRenderingContext2D;
  const blur = backdropBlur(small);
  // Drawn this much larger than the canvas, so the blur does not fade its edges.
  const margin = Math.ceil(blur * 2);
  blurredCtx.filter = `blur(${blur}px)`;

  const opened = new Map<string, Promise<OpenedVideo>>();
  const open = (segment: Extract<ExportSegment, { kind: 'video' }>) => {
    let video = opened.get(segment.video.id);
    if (!video) {
      const file = job.files[segment.video.id];
      if (!file) throw new Error(`The video ${segment.video.label} is not open`);
      video = (async () => {
        const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
        const track = await input.getPrimaryVideoTrack();
        if (!track || !(await track.canDecode())) {
          throw new Error(`This browser cannot decode ${segment.video.label}`);
        }
        const sound = audioCodec ? await input.getPrimaryAudioTrack() : null;
        const audio =
          sound && (await sound.canDecode()) ? new AudioSampleSink(sound as InputAudioTrack) : null;
        if (sound && !audio) warnings.add(`This browser cannot decode the sound of ${segment.video.label}`);
        return {
          input,
          video: track,
          frames: new VideoSampleSink(track, { hardwareAcceleration }),
          audio,
        };
      })();
      opened.set(segment.video.id, video);
    }
    return video;
  };

  const target = await openTarget(job.target);
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(target.writable, { chunked: true, chunkSize: 16 * 2 ** 20 }),
  });
  const video = new CanvasSource(canvas, {
    codec: videoCodec,
    quality: new Quality({ bitrate }),
    keyFrameInterval: encoder.keyframeIntervalSeconds,
    latencyMode: 'quality',
    hardwareAcceleration,
  });
  output.addVideoTrack(video);
  const sound = audioCodec
    ? new AudioSampleSource({
        codec: audioCodec,
        quality: new Quality({ bitrate: audioBitrate }),
      })
    : null;
  if (sound) output.addAudioTrack(sound);

  let pool: FramePool<'bitmap'> | null = null;
  const requested = new Map<number, Promise<DrawnFrame<'bitmap'>>>();
  try {
    await output.start();
    pool = await FramePool.start(job.overlay, job.workers, 'bitmap');
    const ahead = Math.max(2, pool.size * 3);
    let scheduled = 0;
    let audio: AsyncGenerator<AudioSample> | null = sound ? audioSamples(plan.segments, open) : null;
    let audioUntil = 0;
    /** Audio up to `time` (output seconds), so the tracks stay interleaved. */
    const addAudio = async (time: number) => {
      while (audio && sound && audioUntil < time) {
        const next = await audio.next();
        if (next.done) {
          audio = null;
          break;
        }
        audioUntil = next.value.timestamp + next.value.duration;
        await sound.add(next.value);
        next.value.close();
      }
    };
    let lastReport = 0;
    // Where frames go, recomputed when the frame size or turn changes.
    let placement = null as { key: string; frame: FramePlacement; backdrop: FramePlacement } | null;

    for (const piece of pieceFrames(plan.segments, frames, frameRate)) {
      const { segment } = piece;
      const source = segment.kind === 'video' ? await open(segment) : null;
      const samples = source ? source.frames.samplesAtTimestamps(piece.times) : null;
      try {
        for (let i = 0; i < piece.count; i++) {
          check();
          const n = piece.first + i;
          while (scheduled < frames && scheduled < n + ahead) {
            requested.set(scheduled, pool.frame(scheduled));
            scheduled++;
          }
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, width, height);
          const sample = samples ? (await samples.next()).value : null;
          if (sample) {
            const coded = { width: sample.squarePixelWidth, height: sample.squarePixelHeight };
            const rotation = sample.rotation as VideoRotation;
            const key = `${coded.width}x${coded.height}r${rotation}`;
            if (placement?.key !== key) {
              placement = {
                key,
                frame: framePlacement(coded, rotation, { width, height }, fit),
                backdrop: backdropPlacement(coded, rotation, small, fit),
              };
            }
            const image = sample.toCanvasImageSource();
            if (fit.mode === 'blur') {
              backdropCtx.clearRect(0, 0, small.width, small.height);
              drawPlaced(backdropCtx, image, placement.backdrop);
              blurredCtx.drawImage(
                backdrop,
                -margin,
                -margin,
                small.width + 2 * margin,
                small.height + 2 * margin,
              );
              ctx.drawImage(blurred, 0, 0, width, height);
            }
            drawPlaced(ctx, image, placement.frame);
            sample.close();
          }
          const overlay = await requested.get(n);
          requested.delete(n);
          if (overlay) {
            for (const warning of overlay.warnings) warnings.add(warning);
            ctx.drawImage(overlay.data, 0, 0);
            overlay.data.close();
          }
          await addAudio((n + 1) / frameRate + AUDIO_LEAD);
          await video.add(n / frameRate, 1 / frameRate);

          const now = performance.now();
          if (now - lastReport > 250 || n === frames - 1) {
            lastReport = now;
            const elapsed = (now - started) / 1000;
            const fps = (n + 1) / Math.max(elapsed, 1e-3);
            onProgress({
              frame: n + 1,
              frames,
              fps,
              elapsedSeconds: elapsed,
              etaSeconds: n > 10 ? (frames - n - 1) / fps : Number.NaN,
              phase: 'render',
            });
          }
        }
      } finally {
        await samples?.return(undefined);
      }
    }
    await addAudio(Number.POSITIVE_INFINITY);
    check();
    await output.finalize();
  } catch (error) {
    if (output.state === 'started' || output.state === 'pending')
      await output.cancel().catch(() => undefined);
    await target.discard();
    throw error;
  } finally {
    for (const pending of requested.values()) {
      pending.then((frame) => frame.data.close()).catch(() => undefined);
    }
    pool?.close();
    for (const video of opened.values()) {
      video.then((v) => v.input.dispose()).catch(() => undefined);
    }
  }
  return {
    frames,
    encoder: audioCodec ? `${videoCodec} + ${audioCodec}` : videoCodec,
    warnings: [...warnings],
  };
}

addEventListener('message', (event: MessageEvent<VideoWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'cancel') {
    cancelled = true;
    return;
  }
  cancelled = false;
  run(request.job, (progress) => reply({ type: 'progress', progress }))
    .then((result) => reply({ type: 'done', result }))
    .catch((error: unknown) =>
      reply({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
        cancelled: error instanceof Cancelled,
      }),
    );
});
