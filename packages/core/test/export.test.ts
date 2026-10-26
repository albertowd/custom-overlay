import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fitFilters } from '../src/export/canvas.js';
import {
  colorArgs,
  defaultExportRange,
  encoderArgs,
  encoderCandidates,
  estimateExportBytes,
  exportFrameCount,
  exportRange,
  exportSegments,
  imageSequenceCommand,
  imageSequencePlan,
  sequenceFrameName,
  videoExportCommand,
} from '../src/export/plan.js';
import { createProject, createTemplate, type Project } from '../src/model/project.js';
import { exportProject, resolveFfmpegPath } from '../src/node/export.js';
import { addVideo } from '../src/project-ops.js';
import { createWidget } from '../src/widgets/registry.js';
import type { ProjectMedia } from '../src/workflow/timeline.js';
import { videoInfo } from './helpers/fixtures.js';

/** Two 60 s videos: A at 0, B at 100 (a 40 s gap between them), B without sound. */
function twoVideos(overrides: Partial<Project['export']> = {}) {
  let project = createProject();
  const a = addVideo(project, {
    path: '/a.mp4',
    info: videoInfo({ path: '/a.mp4', durationSeconds: 60 }),
    hasTelemetry: false,
  });
  project = a.project;
  const b = addVideo(project, {
    path: '/b.mp4',
    info: videoInfo({ path: '/b.mp4', durationSeconds: 60 }),
    hasTelemetry: false,
  });
  project = {
    ...b.project,
    videos: b.project.videos.map((v) => (v.id === b.video.id ? { ...v, offsetSeconds: 100 } : v)),
    output: { ...b.project.output, width: 1280, height: 720, frameRate: 30 },
    export: { ...b.project.export, outputPath: '/out.mp4', ...overrides },
  };
  const media: ProjectMedia = {
    videos: {
      [a.video.id]: videoInfo({ path: '/a.mp4', durationSeconds: 60 }),
      [b.video.id]: videoInfo({ path: '/b.mp4', durationSeconds: 60, hasAudio: false }),
    },
    series: {},
  };
  return { project, media };
}

describe('export plan', () => {
  it('splits the range into video pieces and gaps', () => {
    const { project, media } = twoVideos();
    const segments = exportSegments(project, media, 30, 130);
    expect(
      segments.map((s) => [
        s.kind,
        s.kind === 'video' ? s.info.path : '',
        s.kind === 'video' ? s.from : 0,
        s.duration,
      ]),
    ).toEqual([
      ['video', '/a.mp4', 30, 30],
      ['gap', '', 0, 40],
      ['video', '/b.mp4', 0, 30],
    ]);
    expect(exportSegments(project, media, 70, 90)).toEqual([{ kind: 'gap', duration: 20 }]);
    expect(exportFrameCount(30, 130, 30)).toBe(3000);
  });

  it('defaults open range bounds to the data range inside the timeline', () => {
    const { project, media } = twoVideos();
    expect(exportRange(project, media)).toEqual({ start: 0, end: 160 });
    expect(exportRange(project, media, { start: 20, end: Number.POSITIVE_INFINITY })).toEqual({
      start: 20,
      end: 160,
    });
    const ended = { ...project, export: { ...project.export, range: { start: null, end: 90 } } };
    expect(exportRange(ended, media, { start: 20, end: 80 })).toEqual({ start: 20, end: 90 });
    // A data range outside the timeline is ignored.
    expect(defaultExportRange({ start: 0, end: 160 }, { start: 200, end: 300 })).toEqual({
      start: 0,
      end: 160,
    });
    expect(defaultExportRange({ start: 0, end: 160 }, null)).toEqual({ start: 0, end: 160 });
  });

  it('estimates the size of a video export', () => {
    const encoder = { ...createProject().export.encoder, bitrateMbps: 12, audioBitrateKbps: 384 };
    // 60 s of 12 Mbps + 384 kbps = 92.88 MB, plus the MP4 overhead.
    expect(estimateExportBytes(encoder, 60)).toBeCloseTo(92_880_000 * 1.005, 0);
    expect(estimateExportBytes({ ...encoder, audio: 'none' }, 60)).toBeCloseTo(90_000_000 * 1.005, 0);
    expect(estimateExportBytes(encoder, -1)).toBe(0);
  });

  it('lets the first video win where videos overlap', () => {
    const { project, media } = twoVideos();
    const overlapping = {
      ...project,
      videos: project.videos.map((v, i) => (i === 1 ? { ...v, offsetSeconds: 50 } : v)),
    };
    const segments = exportSegments(overlapping, media, 40, 100);
    expect(segments.map((s) => (s.kind === 'video' ? [s.info.path, s.from, s.duration] : s.kind))).toEqual([
      ['/a.mp4', 40, 20],
      ['/b.mp4', 10, 40],
    ]);
  });

  it('prefers GPU encoders unless software is asked for', () => {
    expect(encoderCandidates('hevc', 'auto', 8).map((e) => e.name)).toEqual([
      'hevc_nvenc',
      'hevc_amf',
      'hevc_qsv',
      'libx265',
    ]);
    expect(encoderCandidates('h264', 'software', 8).map((e) => e.name)).toEqual(['libx264']);
    // GPU H.264 encoders are 8-bit only.
    expect(encoderCandidates('h264', 'auto', 10).map((e) => e.name)).toEqual(['libx264']);
  });

  it('turns encoder settings into ffmpeg arguments', () => {
    const settings = createProject().export.encoder;
    const x264 = encoderArgs(
      { name: 'libx264', family: 'x264', hardware: false },
      { ...settings, bitrateMbps: 12, keyframeIntervalSeconds: 0.5, bFrames: 2 },
      60,
      8,
    );
    expect(x264.join(' ')).toContain(
      '-c:v libx264 -preset medium -profile:v high -b:v 12000k -maxrate 18000k -bufsize 24000k -g 30',
    );
    expect(x264).toEqual(expect.arrayContaining(['-bf', '2', '-flags', '+cgop']));
    const x265 = encoderArgs(
      { name: 'libx265', family: 'x265', hardware: false },
      { ...settings, codec: 'hevc' },
      30,
      10,
    );
    expect(x265.join(' ')).toContain('keyint=15:min-keyint=15:bframes=2:no-open-gop=1');
    expect(x265.slice(-2)).toEqual(['-tag:v', 'hvc1']);
    const amf = encoderArgs({ name: 'h264_amf', family: 'amf', hardware: true }, settings, 30, 8);
    expect(amf).not.toContain('-bf');
  });

  it('describes the output colours to players', () => {
    expect(colorArgs({ space: 'rec709', range: 'limited', bitDepth: 8 }, 'h264').bitstreamFilter).toBe(
      'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0',
    );
    const hlg = colorArgs({ space: 'rec2020-hlg', range: 'full', bitDepth: 10 }, 'hevc');
    expect(hlg.tags).toEqual([
      '-color_primaries',
      'bt2020',
      '-color_trc',
      'arib-std-b67',
      '-colorspace',
      'bt2020nc',
      '-color_range',
      'pc',
    ]);
    expect(hlg.bitstreamFilter).toContain('hevc_metadata=colour_primaries=9:transfer_characteristics=18');
    expect(
      colorArgs({ space: 'rec2020-pq', range: 'limited', bitDepth: 10 }, 'av1').bitstreamFilter,
    ).toContain('av1_metadata=');
  });

  it('builds the ffmpeg command of a video export', () => {
    const { project, media } = twoVideos({ range: { start: 30, end: 130 }, scaling: 'fsr1' });
    const command = videoExportCommand({
      project,
      media,
      outputPath: '/out.mp4',
      encoder: { name: 'libx264', family: 'x264', hardware: false },
      hardwareDecode: 'd3d11va',
    });
    const args = command.args.join(' ');
    expect(command.frames).toBe(3000);
    expect(args).toContain('-hwaccel d3d11va -ss 30 -t 30 -i /a.mp4');
    expect(args).toContain('-f lavfi -t 40 -i color=c=black:s=1280x720:r=30');
    // B has no sound: silence instead.
    expect(args).toContain('-ss 0 -t 30 -i /b.mp4 -f lavfi -t 30 -i anullsrc');
    expect(args).toContain('[0:v:0]fps=30,scale=1280:720:flags=lanczos');
    expect(args).toContain('cas=strength=0.4');
    expect(args).toContain('concat=n=3:v=1:a=1[base][aout]');
    // The fixture video is 10-bit, so is the output.
    expect(args).toContain(
      'unpremultiply=inplace=1,scale=out_color_matrix=bt709:out_range=pc,format=yuva444p10le[widgets]',
    );
    expect(args).toContain('[base][widgets]overlay=0:0:format=yuv444p10:shortest=1,format=yuv420p10le[vout]');
    expect(args).toContain('-f rawvideo -pix_fmt rgba -s 1280x720 -r 30 -i pipe:0');
    expect(args).toContain('-map [aout]');
    expect(command.args[command.args.length - 1]).toBe('/out.mp4');
  });

  it('copies the audio only from a single uncut video', () => {
    const encoder = { name: 'libx264', family: 'x264', hardware: false } as const;
    const single = twoVideos({ range: { start: 10, end: 20 } });
    single.project.export.encoder.audio = 'copy';
    const copied = videoExportCommand({ ...single, outputPath: '/o.mp4', encoder, hardwareDecode: null });
    expect(copied.audio).toBe('copy');
    expect(copied.args.join(' ')).toContain('-map 0:a:0');
    expect(copied.args).not.toContain('-hwaccel');
    const spanning = twoVideos({ range: { start: 50, end: 110 } });
    spanning.project.export.encoder.audio = 'copy';
    expect(
      videoExportCommand({ ...spanning, outputPath: '/o.mp4', encoder, hardwareDecode: null }).audio,
    ).toBe('aac');
    const silent = twoVideos({ range: { start: 10, end: 20 } });
    silent.project.export.encoder.audio = 'none';
    const none = videoExportCommand({ ...silent, outputPath: '/o.mp4', encoder, hardwareDecode: null });
    expect(none.args).toContain('-an');
    expect(none.args.join(' ')).toContain('concat=n=1:v=1:a=0[base];');
  });

  it('builds the ffmpeg command of a PNG sequence', () => {
    const { project, media } = twoVideos({ range: { start: 0, end: 2 } });
    const command = imageSequenceCommand({ project, media, pattern: '/seq/frame_%06d.png' });
    expect(command.frames).toBe(60);
    expect(command.args.join(' ')).toContain('-vf unpremultiply=inplace=1');
    expect(command.args.slice(-3)).toEqual(['-f', 'image2', '/seq/frame_%06d.png']);
  });

  it('plans the frames of a PNG sequence for exports without ffmpeg', () => {
    const { project, media } = twoVideos({ range: { start: 1, end: 3 } });
    const { width, height, frameRate } = project.output;
    expect(imageSequencePlan(project, media)).toEqual({ width, height, frameRate, start: 1, frames: 60 });
    expect(sequenceFrameName(0)).toBe('frame_000000.png');
    expect(sequenceFrameName(123456)).toBe('frame_123456.png');
  });
});

describe('export with ffmpeg', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'custom-overlay-export-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A project without videos: 2 s of timeline from a dummy speed source. */
  function dataOnly(
    mode: 'video' | 'image-sequence',
    outputPath: string,
  ): { project: Project; media: ProjectMedia } {
    const project = createProject({
      output: {
        ...createProject().output,
        width: 320,
        height: 180,
        frameRate: 10,
        color: { space: 'rec709', range: 'limited', bitDepth: 8 },
      },
      template: createTemplate({
        widgets: [createWidget('text', { props: { text: 'Hi', background: true } })],
      }),
      export: {
        ...createProject().export,
        mode,
        outputPath,
        range: { start: 0, end: 2 },
        encoder: { ...createProject().export.encoder, acceleration: 'software', audio: 'none' },
      },
    });
    return { project, media: { videos: {}, series: {} } };
  }

  it('writes a transparent PNG sequence', async () => {
    const out = join(dir, 'seq');
    const progress: number[] = [];
    const result = await exportProject({
      ...dataOnly('image-sequence', out),
      workers: 0,
      onProgress: (p) => progress.push(p.frame),
    });
    expect(result).toMatchObject({ frames: 20, encoder: null, workers: 0, warnings: [] });
    expect((await readdir(out)).filter((f) => f.endsWith('.png'))).toHaveLength(20);
    expect(progress[progress.length - 1]).toBe(20);
  }, 30_000);

  it('encodes a video and removes it when cancelled', async () => {
    const out = join(dir, 'video.mp4');
    const result = await exportProject({ ...dataOnly('video', out), workers: 0 });
    expect(result).toMatchObject({ frames: 20, encoder: 'libx264' });
    expect((await stat(out)).size).toBeGreaterThan(1000);
    const probe = execFileSync(resolveFfmpegPath(), ['-hide_banner', '-i', out, '-f', 'null', '-'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    expect(probe).toBeDefined();

    const cancelled = join(dir, 'cancelled.mp4');
    const controller = new AbortController();
    const run = exportProject({
      ...dataOnly('video', cancelled),
      workers: 0,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    await expect(run).rejects.toThrow(/cancelled/);
    await expect(stat(cancelled)).rejects.toThrow();
  }, 60_000);

  it('places a video on a canvas of another shape', async () => {
    const ffmpeg = resolveFfmpegPath();
    // 1 s of a white 16:9 video.
    const source = join(dir, 'white.mp4');
    execFileSync(ffmpeg, [
      ...['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=320x180:r=10'],
      ...['-t', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', source],
    ]);
    const info = videoInfo({
      path: source,
      width: 320,
      height: 180,
      frameRate: 10,
      durationSeconds: 1,
      hasAudio: false,
      color: { space: 'rec709', range: 'limited', bitDepth: 8 },
    });
    /** Brightness (0-255) at the top and the bottom of the first frame of a 180 × 320 export. */
    const exportWith = async (fit: Project['output']['fit'], path = source) => {
      const media = { ...info, path };
      const added = addVideo(createProject(), { path, info: media, hasTelemetry: false });
      const out = join(dir, `fit-${fit.mode}-${fit.rotation}-${fit.y}.mp4`);
      const project: Project = {
        ...added.project,
        output: { ...added.project.output, width: 180, height: 320, frameRate: 10, fit },
        export: {
          ...added.project.export,
          outputPath: out,
          range: { start: 0, end: 1 },
          encoder: {
            ...added.project.export.encoder,
            preset: 'custom',
            acceleration: 'software',
            audio: 'none',
          },
        },
      };
      await exportProject({
        project,
        media: { videos: { [added.video.id]: media }, series: {} },
        workers: 0,
      });
      const frame = execFileSync(ffmpeg, [
        ...['-hide_banner', '-loglevel', 'error', '-i', out, '-frames:v', '1'],
        ...['-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
      ]);
      expect(frame.length).toBe(180 * 320);
      return { top: frame[10 * 180 + 90] ?? -1, bottom: frame[310 * 180 + 90] ?? -1 };
    };
    const shade = ({ top, bottom }: { top: number; bottom: number }) =>
      [top, bottom].map((v) => (v < 30 ? 'black' : v > 220 ? 'white' : 'grey'));
    const fit = { rotation: 0, rotateWidgets: false, zoom: 1, x: 0.5, y: 0.5 } as const;
    // Black bars above and below the video, or the video at the top and the bars below it.
    expect(shade(await exportWith({ ...fit, mode: 'contain' }))).toEqual(['black', 'black']);
    expect(shade(await exportWith({ ...fit, mode: 'contain', y: 0 }))).toEqual(['white', 'black']);
    for (const mode of ['cover', 'stretch', 'blur'] as const) {
      expect(shade(await exportWith({ ...fit, mode }))).toEqual(['white', 'white']);
    }
    // Turned before fitting: the 16:9 video fills the 9:16 canvas. Its left half is white, so it
    // ends at the top turning clockwise, at the bottom turning counter-clockwise.
    const halves = join(dir, 'halves.mp4');
    execFileSync(ffmpeg, [
      ...['-hide_banner', '-loglevel', 'error', '-y', '-filter_complex'],
      'color=c=white:s=160x180:r=10:d=1[a];color=c=black:s=160x180:r=10:d=1[b];[a][b]hstack',
      ...['-pix_fmt', 'yuv420p', '-c:v', 'libx264', halves],
    ]);
    expect(shade(await exportWith({ ...fit, mode: 'contain', rotation: 90 }, halves))).toEqual([
      'white',
      'black',
    ]);
    expect(shade(await exportWith({ ...fit, mode: 'blur', rotation: 270 }, halves))).toEqual([
      'black',
      'white',
    ]);
  }, 120_000);

  it('blurs the background of GPU decoded (NV12) frames without shifting colours', () => {
    // A grey 16:9 picture in NV12, as d3d11va / videotoolbox hand frames over.
    const graph = fitFilters({
      input: '[0:v:0]',
      output: '[v]',
      id: 'f0',
      width: 180,
      height: 320,
      fit: { mode: 'blur', rotation: 0, rotateWidgets: false, zoom: 1, x: 0.5, y: 0.5 },
      scale: (w, h, ratio) =>
        `scale=${w}:${h}${ratio === 'disable' ? '' : `:force_original_aspect_ratio=${ratio}`}`,
      before: ['format=nv12'],
      after: ['format=yuv444p'],
    }).join(';');
    const frame = execFileSync(resolveFfmpegPath(), [
      ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x808080:s=320x180:d=0.1'],
      ...['-filter_complex', graph, '-map', '[v]', '-frames:v', '1', '-f', 'rawvideo', '-'],
    ]);
    const plane = 180 * 320;
    expect(frame.length).toBe(plane * 3);
    // Neutral chroma everywhere (128 ± 2): the bug turned halves of the background green / purple.
    const chroma = frame.subarray(plane);
    const off = chroma.findIndex((v) => Math.abs(v - 128) > 2);
    expect(off).toBe(-1);
  });

  it('places GPU decoded (NV12) frames like software decoded ones', () => {
    const render = (fit: Project['output']['fit'], before: string[]) => {
      const graph = fitFilters({
        input: '[0:v:0]',
        output: '[v]',
        id: 'f0',
        width: 180,
        height: 320,
        fit,
        scale: (w, h, ratio) =>
          `scale=${w}:${h}${ratio === 'disable' ? '' : `:force_original_aspect_ratio=${ratio}`}`,
        planarFormat: 'yuv444p',
        before,
        after: ['format=yuv444p'],
      }).join(';');
      return execFileSync(resolveFfmpegPath(), [
        ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=0.1'],
        ...['-filter_complex', graph, '-map', '[v]', '-frames:v', '1', '-f', 'rawvideo', '-'],
      ]);
    };
    for (const mode of ['contain', 'cover', 'blur'] as const) {
      for (const rotation of [0, 90, 180, 270] as const) {
        const fit = { mode, rotation, rotateWidgets: false, zoom: 1, x: 0.5, y: 0.5 };
        const software = render(fit, ['format=yuv420p']);
        const gpu = render(fit, ['format=nv12']);
        expect(gpu.length).toBe(software.length);
        let diff = 0;
        for (let i = 0; i < gpu.length; i++) diff += Math.abs((gpu[i] ?? 0) - (software[i] ?? 0));
        expect(diff / gpu.length, `${mode} ${rotation}`).toBeLessThan(2);
      }
    }
  });

  it('refuses an empty range', async () => {
    const { project, media } = dataOnly('video', join(dir, 'empty.mp4'));
    const empty = { ...project, export: { ...project.export, range: { start: 1, end: 1 } } };
    await expect(exportProject({ project: empty, media, workers: 0 })).rejects.toThrow(/range is empty/);
  });
});
