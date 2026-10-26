import type { VideoFit, VideoRotation } from '../model/project.js';

/**
 * The output canvas: its size (the output resolution) is what widgets are placed on, in
 * fractions; the videos are fitted into it (see `VideoFit`).
 */

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

export type CanvasFormatId = 'landscape' | 'vertical' | 'square' | 'portrait';

/** Common canvas shapes (labels translated as `template.canvas.formats.<id>`). */
export interface CanvasFormat {
  id: CanvasFormatId;
  /** Width : height. */
  ratio: readonly [number, number];
}

export const CANVAS_FORMATS: readonly CanvasFormat[] = [
  { id: 'landscape', ratio: [16, 9] },
  { id: 'vertical', ratio: [9, 16] },
  { id: 'square', ratio: [1, 1] },
  { id: 'portrait', ratio: [4, 5] },
];

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Canvas size of a format keeping the short side of the current size, so the quality stays the
 * same: 1920 × 1080 gives 1080 × 1920 vertical, 1080 × 1080 square and 1080 × 1350 portrait.
 */
export function canvasSizeFor(format: CanvasFormat, current: Size): Size {
  const lines = Math.min(current.width, current.height);
  const [w, h] = format.ratio;
  if (w === h) return { width: lines, height: lines };
  return w > h
    ? { width: even((lines * w) / h), height: lines }
    : { width: lines, height: even((lines * h) / w) };
}

/** Whether two sizes have the same shape, give or take rounding (2.7K GoPro is 16:9). */
export function sameAspect(a: Size, b: Size): boolean {
  return Math.abs(a.width / a.height - b.width / b.height) < 0.01;
}

/** The format of a canvas size, when it has one of their aspect ratios. */
export function canvasFormatOf(size: Size): CanvasFormat | undefined {
  return CANVAS_FORMATS.find((f) => sameAspect(size, { width: f.ratio[0], height: f.ratio[1] }));
}

/** Whether a rotation turns the video sideways (its width becomes its height). */
export function isSideways(rotation: VideoRotation): boolean {
  return rotation === 90 || rotation === 270;
}

/** Size of a video once rotated. */
export function rotatedSize(source: Size, rotation: VideoRotation): Size {
  return isSideways(rotation) ? { width: source.height, height: source.width } : source;
}

/**
 * Where a video of `source` size goes on a canvas, in canvas pixels: the box of the video once
 * rotated, fitted after the rotation. The rectangle may extend past the canvas (`cover`, zoom):
 * what is outside is cropped. The export builds the same placement with ffmpeg filters (see
 * `fitFilters`).
 */
export function videoPlacement(source: Size, canvas: Size, fit: VideoFit): Rect {
  const turned = rotatedSize(source, fit.rotation);
  let width = canvas.width;
  let height = canvas.height;
  if (fit.mode !== 'stretch' && turned.width > 0 && turned.height > 0) {
    const sx = canvas.width / turned.width;
    const sy = canvas.height / turned.height;
    const scale = fit.mode === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
    width = turned.width * scale;
    height = turned.height * scale;
  }
  width *= fit.zoom;
  height *= fit.zoom;
  return { x: (canvas.width - width) * fit.x, y: (canvas.height - height) * fit.y, width, height };
}

/** The blurred background of the `blur` mode: the rotated video covering the canvas, centred. */
export function backgroundPlacement(source: Size, canvas: Size, rotation: VideoRotation = 0): Rect {
  return videoPlacement(source, canvas, {
    mode: 'cover',
    rotation,
    rotateWidgets: false,
    zoom: 1,
    x: 0.5,
    y: 0.5,
  });
}

/**
 * The box to draw the unrotated video in so that, turned around its centre, it covers `placed`
 * (a rectangle from `videoPlacement`): the same centre, width and height swapped when sideways.
 */
export function unrotatedBox(placed: Rect, rotation: VideoRotation): Rect {
  if (!isSideways(rotation)) return placed;
  const cx = placed.x + placed.width / 2;
  const cy = placed.y + placed.height / 2;
  return { x: cx - placed.height / 2, y: cy - placed.width / 2, width: placed.height, height: placed.width };
}

/** How much the widgets are turned: the video's rotation when they turn with it, else none. */
export function widgetRotation(output: { fit: VideoFit }): VideoRotation {
  return output.fit.rotateWidgets ? output.fit.rotation : 0;
}

/**
 * The frame widgets are laid out in (their fractions are of it): the canvas, turned back when the
 * widgets turn with a sideways video.
 */
export function widgetFrame(output: Size & { fit: VideoFit }): Size {
  return rotatedSize({ width: output.width, height: output.height }, widgetRotation(output));
}

/** ffmpeg filters turning frames clockwise. */
function rotationFilters(rotation: VideoRotation): string[] {
  if (rotation === 90) return ['transpose=clock'];
  if (rotation === 270) return ['transpose=cclock'];
  if (rotation === 180) return ['hflip', 'vflip'];
  return [];
}

/** Downscale factor of the blurred background (cheap to blur, and blurred again by the upscale). */
export const BLUR_DOWNSCALE = 8;

const num = (n: number) => String(Math.round(n * 1e4) / 1e4);

/** How the scale filter keeps the video's aspect ratio (ffmpeg `force_original_aspect_ratio`). */
export type ScaleRatio = 'decrease' | 'increase' | 'disable';

/**
 * ffmpeg filter chains placing a video on a `width` × `height` canvas like `videoPlacement`,
 * from the frames' own size (so rotated videos work too). `scale` builds the video's scale
 * filter; `sharpen` runs on the scaled video, `before` / `after` around the whole placement.
 * The chains read the `input` pad label (`[0:v:0]`) and write the `output` one.
 */
export function fitFilters(options: {
  input: string;
  output: string;
  /** Prefix of the intermediate pad labels of the `blur` mode, unique in the graph. */
  id: string;
  width: number;
  height: number;
  fit: VideoFit;
  scale(width: string, height: string, ratio: ScaleRatio): string;
  /**
   * Planar pixel format the blurred background is made in: GPU decoders give semi-planar NV12,
   * whose interleaved chroma `boxblur` smears into green and purple halves.
   */
  planarFormat?: string;
  before?: readonly string[];
  sharpen?: readonly string[];
  after?: readonly string[];
}): string[] {
  const { input, output, id, width, height, fit, scale } = options;
  const before = options.before ?? [];
  const after = options.after ?? [];
  const ratio: ScaleRatio =
    fit.mode === 'cover' ? 'increase' : fit.mode === 'stretch' ? 'disable' : 'decrease';
  const x = num(fit.x);
  const y = num(fit.y);
  // Scaled to the canvas turned back, then rotated: turning the scaled frame is cheaper than 4K.
  const sideways = isSideways(fit.rotation);
  const rotate = rotationFilters(fit.rotation);
  const scaleTo = (w: string, h: string, r: ScaleRatio) => (sideways ? scale(h, w, r) : scale(w, h, r));
  // Crop what passes the canvas keeping the part at (x, y), then pad what is missing.
  const crop = `crop=w='min(iw,${width})':h='min(ih,${height})':x='(iw-ow)*${x}':y='(ih-oh)*${y}'`;
  const placed = [
    scaleTo(num(width * fit.zoom), num(height * fit.zoom), ratio),
    ...(options.sharpen ?? []),
    ...rotate,
    crop,
  ];
  if (fit.mode !== 'blur') {
    const pad = `pad=${width}:${height}:x='(ow-iw)*${x}':y='(oh-ih)*${y}':color=black`;
    return [`${input}${[...before, ...placed, pad, 'setsar=1', ...after].join(',')}${output}`];
  }
  // The background: the video covering a small canvas, blurred, then scaled up to the canvas.
  const bw = even(width / BLUR_DOWNSCALE);
  const bh = even(height / BLUR_DOWNSCALE);
  const radius = Math.max(1, Math.floor(Math.min(bw, bh) / 12));
  const background = [
    scaleTo(String(bw), String(bh), 'increase'),
    ...rotate,
    `crop=${bw}:${bh}`,
    `format=${options.planarFormat ?? 'yuv444p'}`,
    `boxblur=${radius}:2`,
    `scale=${width}:${height}:flags=bilinear`,
    'setsar=1',
  ];
  const overlay = `overlay=x='(main_w-overlay_w)*${x}':y='(main_h-overlay_h)*${y}'`;
  return [
    `${input}${[...before, 'split=2'].join(',')}[${id}fg][${id}bg]`,
    `[${id}bg]${background.join(',')}[${id}back]`,
    `[${id}fg]${[...placed, 'setsar=1'].join(',')}[${id}front]`,
    `[${id}back][${id}front]${[overlay, ...after].join(',')}${output}`,
  ];
}
