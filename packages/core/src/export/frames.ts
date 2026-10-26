import type { Palette } from '../model/palette.js';
import type { Project, Template } from '../model/project.js';
import { ProjectValues } from '../values/ranged.js';
import { createPreparedCache, renderOverlay, type ScratchCanvas } from '../widgets/render.js';
import type { ProjectMedia } from '../workflow/timeline.js';
import { widgetRotation } from './canvas.js';

/** Everything needed to draw export frames; structured-cloneable, so it can go to a worker. */
export interface FrameRendererInit {
  project: Project;
  media: ProjectMedia;
  template: Template;
  palette: Palette;
  width: number;
  height: number;
  frameRate: number;
  /** Timeline time of frame 0. */
  start: number;
  utcOffsetMinutes?: number;
}

/** The canvas of a platform: Skia in Node, OffscreenCanvas in browsers. */
export interface RenderPlatform {
  createCanvas(width: number, height: number): ScratchCanvas;
  /** Decode an image of the widgets' props (a data URL). */
  loadImage(src: string): Promise<CanvasImageSource>;
}

/** Draws frame `frame` on `ctx` (cleared first); returns the widget errors as `name: message`. */
export type DrawFrame = (ctx: CanvasRenderingContext2D, frame: number) => string[];

/** Every data URL used by the widgets' props, decoded once. */
async function loadWidgetImages(template: Template, platform: RenderPlatform) {
  const sources = new Set<string>();
  for (const widget of template.widgets) {
    for (const value of Object.values(widget.props)) {
      if (typeof value === 'string' && value.startsWith('data:')) sources.add(value);
    }
  }
  const images = new Map<string, CanvasImageSource>();
  for (const src of sources) {
    try {
      images.set(src, await platform.loadImage(src));
    } catch {
      // A broken image draws nothing, like in the editor.
    }
  }
  return images;
}

/** Scratch canvases for anti-aliasing, reused by size (widgets are drawn one at a time). */
function scratchPool(platform: RenderPlatform): (width: number, height: number) => ScratchCanvas {
  const pool = new Map<string, ScratchCanvas>();
  return (width, height) => {
    const key = `${width}x${height}`;
    let scratch = pool.get(key);
    if (!scratch) {
      scratch = platform.createCanvas(width, height);
      pool.set(key, scratch);
    }
    scratch.ctx.setTransform(1, 0, 0, 1, 0, 0);
    scratch.ctx.globalAlpha = 1;
    scratch.ctx.clearRect(0, 0, width, height);
    return scratch;
  };
}

/**
 * Draws export frames with the editor's widget code on any platform's canvas. Values are
 * evaluated at the export frame rate, for the project's data range and each widget's own.
 */
export async function createFrameDrawer(
  init: FrameRendererInit,
  platform: RenderPlatform,
): Promise<DrawFrame> {
  const { template, width, height, frameRate, start } = init;
  // The project's data range, and the widgets' own ones.
  const values = new ProjectValues(init.project, init.media, { frameRate });
  const engine = values.engine;
  const series = values.seriesOf(engine);
  const images = await loadWidgetImages(template, platform);
  const createScratch = scratchPool(platform);
  const cache = createPreparedCache();
  const names = new Map(template.widgets.map((w) => [w.id, w.name || w.type]));

  return (ctx, frame) => {
    const time = start + frame / frameRate;
    ctx.clearRect(0, 0, width, height);
    const report = renderOverlay(ctx, {
      width,
      height,
      rotation: widgetRotation(init.project.output),
      template,
      palette: init.palette,
      frame: {
        series,
        seriesFor: (widget) => values.seriesFor(widget),
        frameIndex: engine.frameAt(time),
        time,
      },
      image: (src) => images.get(src),
      createCanvas: createScratch,
      cache,
      utcOffsetMinutes: init.utcOffsetMinutes,
    });
    return Object.entries(report).map(([id, message]) => `${names.get(id) ?? id}: ${message}`);
  };
}
