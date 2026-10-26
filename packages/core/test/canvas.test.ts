import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import {
  backgroundPlacement,
  CANVAS_FORMATS,
  canvasFormatOf,
  canvasSizeFor,
  fitFilters,
  rotatedSize,
  sameAspect,
  unrotatedBox,
  videoPlacement,
  widgetFrame,
  widgetRotation,
} from '../src/export/canvas.js';
import { ENCODE_PRESETS, presetNotes, SOCIAL_FAMILIES, socialTargetOf } from '../src/export/presets.js';
import { DEFAULT_PALETTE } from '../src/model/palette.js';
import { createProject, createTemplate, parseProject, type VideoFit } from '../src/model/project.js';
import { addVideo, applyPreset, fitWidgetsToCanvas, setOutput } from '../src/project-ops.js';
import { createWidget, defaultWidgetSize, getWidgetType } from '../src/widgets/registry.js';
import { renderOverlay } from '../src/widgets/render.js';
import { videoInfo } from './helpers/fixtures.js';

const fit = (overrides: Partial<VideoFit> = {}): VideoFit => ({
  mode: 'contain',
  rotation: 0,
  rotateWidgets: false,
  zoom: 1,
  x: 0.5,
  y: 0.5,
  ...overrides,
});
const format = (id: string) => {
  const found = CANVAS_FORMATS.find((f) => f.id === id);
  if (!found) throw new Error(`no format ${id}`);
  return found;
};
const video = { width: 1920, height: 1080 };
const vertical = { width: 1080, height: 1920 };

describe('canvas formats', () => {
  it('keeps the short side when changing shape', () => {
    expect(canvasSizeFor(format('vertical'), video)).toEqual({ width: 1080, height: 1920 });
    expect(canvasSizeFor(format('square'), video)).toEqual({ width: 1080, height: 1080 });
    expect(canvasSizeFor(format('portrait'), video)).toEqual({ width: 1080, height: 1350 });
    expect(canvasSizeFor(format('landscape'), vertical)).toEqual({ width: 1920, height: 1080 });
    // 2.7K GoPro: even sizes.
    expect(canvasSizeFor(format('vertical'), { width: 2704, height: 1520 })).toEqual({
      width: 1520,
      height: 2702,
    });
  });

  it('recognizes the format of a size', () => {
    expect(canvasFormatOf({ width: 2704, height: 1520 })?.id).toBe('landscape');
    expect(canvasFormatOf(vertical)?.id).toBe('vertical');
    expect(canvasFormatOf({ width: 1080, height: 1350 })?.id).toBe('portrait');
    expect(canvasFormatOf({ width: 2560, height: 1080 })).toBeUndefined();
    expect(sameAspect({ width: 1920, height: 960 }, { width: 16, height: 9 })).toBe(false);
  });
});

describe('video placement', () => {
  it('contains, covers or stretches a video on the canvas', () => {
    expect(videoPlacement(video, vertical, fit())).toEqual({ x: 0, y: 656.25, width: 1080, height: 607.5 });
    expect(videoPlacement(video, vertical, fit({ mode: 'blur' }))).toEqual(
      videoPlacement(video, vertical, fit()),
    );
    const cover = videoPlacement(video, vertical, fit({ mode: 'cover' }));
    expect(cover.height).toBe(1920);
    expect(cover.width).toBeCloseTo(3413.33, 2);
    expect(cover.x).toBeCloseTo((1080 - cover.width) / 2, 6);
    expect(videoPlacement(video, vertical, fit({ mode: 'stretch' }))).toEqual({
      x: 0,
      y: 0,
      width: 1080,
      height: 1920,
    });
    expect(backgroundPlacement(video, vertical)).toEqual(cover);
  });

  it('aligns and zooms the video', () => {
    // At the top of the canvas, the widgets below it.
    expect(videoPlacement(video, vertical, fit({ y: 0 })).y).toBe(0);
    expect(videoPlacement(video, vertical, fit({ y: 1 })).y).toBe(1920 - 607.5);
    // Covering, keeping the left of the frame (where the driver sits).
    expect(videoPlacement(video, vertical, fit({ mode: 'cover', x: 0 })).x).toBeCloseTo(0, 6);
    const zoomed = videoPlacement(video, vertical, fit({ zoom: 2 }));
    expect(zoomed).toEqual({ x: -540, y: 352.5, width: 2160, height: 1215 });
  });

  it('fits the video after turning it', () => {
    expect(rotatedSize(video, 90)).toEqual(vertical);
    expect(rotatedSize(video, 180)).toEqual(video);
    // A landscape video turned sideways uses the whole vertical canvas.
    const turned = videoPlacement(video, vertical, fit({ rotation: 90 }));
    expect(turned).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
    // The element keeps the video's shape, centred on the placement, before being turned.
    expect(unrotatedBox(turned, 90)).toEqual({ x: -420, y: 420, width: 1920, height: 1080 });
    expect(unrotatedBox(turned, 180)).toBe(turned);
    // Upside down, still letterboxed.
    expect(videoPlacement(video, vertical, fit({ rotation: 180 }))).toEqual(
      videoPlacement(video, vertical, fit()),
    );
    // On a landscape canvas a turned video is pillarboxed.
    const pillar = videoPlacement(video, video, fit({ rotation: 270 }));
    expect(pillar.height).toBe(1080);
    expect(pillar.width).toBeCloseTo(607.5, 6);
    expect(backgroundPlacement(video, video, 270)).toMatchObject({ x: 0, width: 1920 });
  });

  it('builds the same placement with ffmpeg filters', () => {
    const scale = (w: string, h: string, ratio: string) => `scale=${w}:${h}:${ratio}`;
    const base = { input: '[0:v:0]', output: '[v0]', id: 'f0', width: 1080, height: 1920, scale };
    const [contain, ...rest] = fitFilters({
      ...base,
      fit: fit({ y: 0 }),
      before: ['fps=60'],
      after: ['format=yuv444p'],
    });
    expect(rest).toEqual([]);
    expect(contain).toBe(
      "[0:v:0]fps=60,scale=1080:1920:decrease,crop=w='min(iw,1080)':h='min(ih,1920)':x='(iw-ow)*0.5':y='(ih-oh)*0',pad=1080:1920:x='(ow-iw)*0.5':y='(oh-ih)*0':color=black,setsar=1,format=yuv444p[v0]",
    );
    expect(fitFilters({ ...base, fit: fit({ mode: 'cover', zoom: 1.5 }) })[0]).toContain(
      'scale=1620:2880:increase',
    );
    expect(fitFilters({ ...base, fit: fit({ mode: 'stretch' }) })[0]).toContain('scale=1080:1920:disable');
    // Scaled to the canvas turned back, then turned: cheaper than turning the full frame.
    expect(fitFilters({ ...base, fit: fit({ rotation: 90 }) })[0]).toContain(
      "scale=1920:1080:decrease,transpose=clock,crop=w='min(iw,1080)'",
    );
    expect(fitFilters({ ...base, fit: fit({ mode: 'cover', rotation: 270, zoom: 2 }) })[0]).toContain(
      'scale=3840:2160:increase,transpose=cclock,crop',
    );
    expect(fitFilters({ ...base, fit: fit({ rotation: 180 }) })[0]).toContain(
      'scale=1080:1920:decrease,hflip,vflip,crop',
    );
    expect(fitFilters({ ...base, fit: fit({ mode: 'blur', rotation: 90 }) })[1]).toBe(
      '[f0bg]scale=240:136:increase,transpose=clock,crop=136:240,format=yuv444p,boxblur=11:2,scale=1080:1920:flags=bilinear,setsar=1[f0back]',
    );
    const blur = fitFilters({
      ...base,
      fit: fit({ mode: 'blur' }),
      sharpen: ['cas'],
      after: ['format=yuv444p'],
    });
    expect(blur).toEqual([
      '[0:v:0]split=2[f0fg][f0bg]',
      '[f0bg]scale=136:240:increase,crop=136:240,format=yuv444p,boxblur=11:2,scale=1080:1920:flags=bilinear,setsar=1[f0back]',
      "[f0fg]scale=1080:1920:decrease,cas,crop=w='min(iw,1080)':h='min(ih,1920)':x='(iw-ow)*0.5':y='(ih-oh)*0.5',setsar=1[f0front]",
      "[f0back][f0front]overlay=x='(main_w-overlay_w)*0.5':y='(main_h-overlay_h)*0.5',format=yuv444p[v0]",
    ]);
  });
});

describe('widgets on the canvas', () => {
  it('sizes new widgets for the canvas shape', () => {
    const gauge = getWidgetType('speed-gauge');
    if (!gauge) throw new Error('missing gauge');
    expect(defaultWidgetSize(gauge, video)).toEqual(gauge.defaultSize);
    const size = defaultWidgetSize(gauge, vertical);
    // As many pixels as on a 16:9 frame of the same short side, still square.
    expect(size.width * 1080).toBeCloseTo(gauge.defaultSize.width * 1920, -1);
    expect(size.width * 1080).toBeCloseTo(size.height * 1920, -1);
    const widget = createWidget('speed-gauge', {}, vertical);
    expect(widget.x).toBeCloseTo((1 - size.width) / 2, 6);
  });

  it('keeps aspect-locked widgets square when the canvas changes shape', () => {
    const gauge = createWidget('speed-gauge', {
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.3556,
      anchor: 'center',
    });
    const text = createWidget('text', { width: 0.3, height: 0.1 });
    const template = createTemplate({ widgets: [gauge, text] });
    const [fitted, untouched] = fitWidgetsToCanvas(template, video, vertical).widgets;
    expect(fitted?.width).toBe(0.2);
    expect(fitted?.height).toBeCloseTo((0.2 * 1080) / 1920, 4);
    // Around its anchor (the centre).
    expect((fitted?.y ?? 0) + (fitted?.height ?? 0) / 2).toBeCloseTo(0.1 + 0.3556 / 2, 4);
    expect(untouched).toEqual(text);
    expect(fitWidgetsToCanvas(template, video, { width: 2704, height: 1520 })).toBe(template);

    const project = setOutput(createProject({ template }), vertical);
    expect(project.template.widgets[0]?.height).toBeCloseTo((0.2 * 1080) / 1920, 4);
    expect(project.output.fit.mode).toBe('contain');
  });
});

describe('social presets', () => {
  it('offers TikTok and Instagram at both frame rate columns', () => {
    const social = ENCODE_PRESETS.filter((p) => p.social).map((p) => p.id);
    expect(social).toEqual([
      'tiktok-30',
      'tiktok-60',
      'instagram-reels-30',
      'instagram-reels-60',
      'instagram-feed-30',
      'instagram-feed-60',
    ]);
    expect(SOCIAL_FAMILIES.map((f) => `${f.width}x${f.height}`)).toEqual([
      '1080x1920',
      '1080x1920',
      '1080x1350',
    ]);
    expect(socialTargetOf('tiktok-60')?.bitrateMbps).toBe(12);
    expect(socialTargetOf('youtube-sdr-h264-1080p60')).toBeUndefined();
  });

  it('moves the canvas and frame rate to the platform format', () => {
    const { project } = addVideo(createProject(), {
      path: '/v.mp4',
      info: videoInfo({ frameRate: 119.88, color: { space: 'rec709', range: 'limited', bitDepth: 8 } }),
      hasTelemetry: false,
    });
    const tiktok = applyPreset(project, 'tiktok-30');
    expect(tiktok.output).toMatchObject({ width: 1080, height: 1920, frameRate: 29.97 });
    expect(tiktok.export.encoder).toMatchObject({
      preset: 'tiktok-30',
      codec: 'h264',
      bitrateMbps: 8,
      audio: 'aac',
    });
    expect(presetNotes('tiktok-30', tiktok.output)).toEqual([]);
    const feed = applyPreset(tiktok, 'instagram-feed-60');
    expect(feed.output).toMatchObject({ width: 1080, height: 1350, frameRate: 59.94 });
    // The preset stays when the output is edited, with notes on what no longer suits it.
    const edited = setOutput(feed, { width: 1920, height: 1080, frameRate: 120 });
    expect(edited.export.encoder.preset).toBe('instagram-feed-60');
    expect(
      presetNotes('instagram-feed-60', { ...edited.output, color: { ...edited.output.color, bitDepth: 10 } }),
    ).toEqual(['socialSdr', 'socialSize', 'socialFrameRate']);
  });

  it('keeps the platform canvas when the first video is added', () => {
    const empty = applyPreset(createProject(), 'instagram-reels-60');
    const { project } = addVideo(empty, {
      path: '/v.mp4',
      info: videoInfo({ frameRate: 119.88 }),
      hasTelemetry: false,
    });
    expect(project.output).toMatchObject({ width: 1080, height: 1920, frameRate: 59.94 });
    expect(project.export.encoder.preset).toBe('instagram-reels-60');
  });

  it('reads projects saved before the canvas fit existed', () => {
    const project = parseProject({ version: 1, output: { width: 1920, height: 1080 } });
    expect(project.output.fit).toEqual(fit());
  });
});

describe('widgets turning with the video', () => {
  const canvas = { width: 180, height: 320 };

  it('lays the widgets out on the canvas turned back', () => {
    const turned = { ...canvas, fit: fit({ rotation: 90, rotateWidgets: true }) };
    expect(widgetRotation(turned)).toBe(90);
    expect(widgetFrame(turned)).toEqual({ width: 320, height: 180 });
    // Upright widgets, or a video that is not turned: the canvas itself.
    expect(widgetFrame({ ...canvas, fit: fit({ rotation: 90 }) })).toEqual(canvas);
    expect(widgetRotation({ fit: fit({ rotateWidgets: true }) })).toBe(0);
    expect(widgetFrame({ ...canvas, fit: fit({ rotation: 180, rotateWidgets: true }) })).toEqual(canvas);
  });

  it('draws the turned-back frame onto the canvas', () => {
    // A filled box on the top-left quarter of the widget frame.
    const template = createTemplate({
      antialias: false,
      widgets: [createWidget('shape', { x: 0, y: 0, width: 0.5, height: 0.5 })],
    });
    const draw = (rotation: 90 | 180 | 270) => {
      const target = createCanvas(canvas.width, canvas.height);
      const ctx = target.getContext('2d') as unknown as CanvasRenderingContext2D;
      renderOverlay(ctx, {
        ...canvas,
        rotation,
        template,
        palette: DEFAULT_PALETTE,
        frame: { series: { times: new Float64Array(0), get: () => undefined }, frameIndex: -1, time: 0 },
      });
      const alpha = (x: number, y: number) =>
        (target.getContext('2d').getImageData(x, y, 1, 1).data[3] ?? 0) > 0 ? 1 : 0;
      return {
        topLeft: alpha(30, 40),
        topRight: alpha(150, 40),
        bottomLeft: alpha(30, 280),
        bottomRight: alpha(150, 280),
      };
    };
    // Clockwise, its top-left corner goes to the top-right.
    expect(draw(90)).toEqual({ topLeft: 0, topRight: 1, bottomLeft: 0, bottomRight: 0 });
    expect(draw(270)).toEqual({ topLeft: 0, topRight: 0, bottomLeft: 1, bottomRight: 0 });
    expect(draw(180)).toEqual({ topLeft: 0, topRight: 0, bottomLeft: 0, bottomRight: 1 });
  });

  it('refits square widgets when they start or stop turning', () => {
    const gauge = createWidget('speed-gauge', { x: 0.1, y: 0.1, width: 0.2, height: 0.1125 });
    const vertical = setOutput(createProject({ template: createTemplate({ widgets: [gauge] }) }), {
      width: 1080,
      height: 1920,
    });
    const square = (p: typeof vertical) => {
      const w = p.template.widgets[0];
      const frame = widgetFrame(p.output);
      return ((w?.width ?? 0) * frame.width) / ((w?.height ?? 1) * frame.height);
    };
    expect(square(vertical)).toBeCloseTo(1, 3);
    const turned = setOutput(vertical, { fit: fit({ rotation: 90, rotateWidgets: true }) });
    expect(widgetFrame(turned.output)).toEqual({ width: 1920, height: 1080 });
    expect(square(turned)).toBeCloseTo(1, 3);
  });
});
