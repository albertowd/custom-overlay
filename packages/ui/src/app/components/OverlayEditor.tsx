import {
  anchorFactors,
  anchorPoint,
  createPreparedCache,
  createSampleSeries,
  dragResize,
  getWidgetType,
  guideLines,
  type RenderReport,
  renderOverlay,
  resizeAroundAnchor,
  resizeCorner,
  rotatedSize,
  type ScratchCanvas,
  snapOffset,
  type ValueSeries,
  type VideoRotation,
  type Widget,
  widgetFrame,
  widgetRotation,
} from '@custom-overlay/core';
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useStore, useTimeline } from '../store';
import { snapshotSeries, widgetSeries } from '../values';

const SAMPLE_SECONDS = 120;
const SAMPLE_RATE = 30;
const SAMPLE_SERIES = createSampleSeries(SAMPLE_SECONDS, SAMPLE_RATE);

/**
 * Values to preview with: project values, or the sample session when asked or without data.
 * `final` ignores the sample data switch, as the export does.
 */
function usePreviewSeries(final = false): {
  series: ValueSeries;
  sample: boolean;
  frameIndexAt(time: number): number;
} {
  const snapshot = useStore((s) => s.values);
  const sampleData = useStore((s) => s.sampleData) && !final;
  return useMemo(() => {
    if (snapshot && snapshot.grid.count > 0 && !sampleData) {
      const { start, frameRate, count } = snapshot.grid;
      return {
        series: snapshotSeries(snapshot),
        sample: false,
        frameIndexAt: (time) => Math.min(Math.max(Math.round((time - start) * frameRate), 0), count - 1),
      };
    }
    const frames = SAMPLE_SECONDS * SAMPLE_RATE;
    return {
      series: SAMPLE_SERIES,
      sample: true,
      frameIndexAt: (time) => ((Math.round(time * SAMPLE_RATE) % frames) + frames) % frames,
    };
  }, [snapshot, sampleData]);
}

/** Decoded images by data URL; `version` changes when one finishes loading. */
function useImages(): { image(src: string): CanvasImageSource | undefined; version: number } {
  const cache = useRef(new Map<string, HTMLImageElement>());
  const [version, setVersion] = useState(0);
  return useMemo(
    () => ({
      version,
      image(src: string) {
        const cached = cache.current.get(src);
        if (cached) return cached.complete && cached.naturalWidth > 0 ? cached : undefined;
        const img = new Image();
        img.onload = () => setVersion((v) => v + 1);
        img.src = src;
        cache.current.set(src, img);
        return undefined;
      },
    }),
    [version],
  );
}

/** Scratch canvases reused by size for anti-aliasing. */
function useScratchCanvases(): (width: number, height: number) => ScratchCanvas {
  const pool = useRef(new Map<string, ScratchCanvas>());
  return useMemo(
    () => (width: number, height: number) => {
      const key = `${width}x${height}`;
      let scratch = pool.current.get(key);
      if (!scratch) {
        const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
        scratch = { canvas, ctx: canvas.getContext('2d') as unknown as CanvasRenderingContext2D };
        if (pool.current.size > 64) pool.current.clear();
        pool.current.set(key, scratch);
      }
      scratch.ctx.setTransform(1, 0, 0, 1, 0, 0);
      scratch.ctx.clearRect(0, 0, width, height);
      return scratch;
    },
    [],
  );
}

interface OverlayCanvasProps {
  editing: boolean;
  /** Show what the export renders: project values only, no test values or sample session. */
  final?: boolean;
  onReport?(report: RenderReport): void;
}

/** The template rendered over the stage, following the playhead. */
export function OverlayCanvas({ editing, final = false, onReport }: OverlayCanvasProps) {
  const template = useStore((s) => s.project.template);
  const palette = useStore((s) => s.project.palette);
  const currentTime = useStore((s) => s.currentTime);
  const testValues = useStore((s) => s.testValues);
  const timeline = useTimeline();
  const preview = usePreviewSeries(final);
  const snapshot = useStore((s) => s.values);
  const images = useImages();
  const createCanvas = useScratchCanvases();
  const cache = useRef(createPreparedCache());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // Without a timeline the sample session plays on its own so widgets can be designed.
  const [sampleClock, setSampleClock] = useState(0);
  const animateSamples = preview.sample && timeline.durationSeconds <= 0;

  useEffect(() => {
    const el = canvasRef.current?.parentElement;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!animateSamples) return;
    let handle = 0;
    const started = performance.now();
    const tick = (now: number) => {
      setSampleClock((now - started) / 1000);
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [animateSamples]);

  const time = animateSamples ? sampleClock : currentTime;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || size.width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(size.width * dpr);
    const height = Math.round(size.height * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.clearRect(0, 0, width, height);
    const report = renderOverlay(ctx, {
      width,
      height,
      template,
      palette,
      frame: {
        series: preview.series,
        // Widgets with their own data range read their own values (not with the sample session).
        seriesFor:
          snapshot && !preview.sample
            ? (widget) => widgetSeries(snapshot, preview.series, widget)
            : undefined,
        frameIndex: preview.frameIndexAt(time),
        time,
      },
      testValues: final ? undefined : testValues,
      image: images.image,
      createCanvas,
      cache: cache.current,
      editing,
      ignoreShowWhen: false,
    });
    onReport?.(report);
  }, [
    template,
    palette,
    preview,
    snapshot,
    time,
    testValues,
    images,
    size,
    editing,
    final,
    createCanvas,
    onReport,
  ]);

  return <canvas ref={canvasRef} className="overlay-canvas" style={{ width: '100%', height: '100%' }} />;
}

type DragMode = 'move' | 'resize';

/** A screen movement in the axes of a layer turned clockwise by `rotation`. */
function unturn(x: number, y: number, rotation: VideoRotation): { x: number; y: number } {
  if (rotation === 90) return { x: y, y: -x };
  if (rotation === 180) return { x: -x, y: -y };
  if (rotation === 270) return { x: -y, y: x };
  return { x, y };
}

/** Snapping distance in screen pixels. */
const SNAP_PX = 8;

interface ActiveLines {
  v: number | null;
  h: number | null;
}

/** The template's snap lines over the stage; the lines a drag snaps to are highlighted. */
function GuideLines({ active }: { active: ActiveLines }) {
  const guides = useStore((s) => s.project.template.guides);
  const show = useStore((s) => s.showGuides);
  const lines = useMemo(() => guideLines(guides), [guides]);
  if (!show && active.v === null && active.h === null) return null;
  // The frame edges are lines too, but already visible.
  const inner = (values: number[], current: number | null) =>
    values.filter((v) => v > 0 && v < 1 && (show || v === current));
  return (
    <div className="guide-lines">
      {inner(lines.vertical, active.v).map((v) => (
        <div
          key={`v${v}`}
          className={`guide v ${v === active.v ? 'active' : ''}`}
          style={{ left: `${v * 100}%` }}
        />
      ))}
      {inner(lines.horizontal, active.h).map((h) => (
        <div
          key={`h${h}`}
          className={`guide h ${h === active.h ? 'active' : ''}`}
          style={{ top: `${h * 100}%` }}
        />
      ))}
    </div>
  );
}

/** Selection and drag / resize handles over the widgets, snapping to the guides. */
function WidgetHandles({ errors }: { errors: RenderReport }) {
  const widgets = useStore((s) => s.project.template.widgets);
  const guides = useStore((s) => s.project.template.guides);
  const output = useStore((s) => s.project.output);
  const selectedId = useStore((s) => s.selectedWidgetId);
  const t = useT();
  const snap = useStore((s) => s.snap);
  const select = useStore((s) => s.selectWidget);
  const update = useStore((s) => s.updateWidget);
  const layerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; mode: DragMode; x: number; y: number; start: Widget } | null>(null);
  const [active, setActive] = useState<ActiveLines>({ v: null, h: null });
  const lines = useMemo(() => guideLines(guides), [guides]);

  const begin = (event: ReactPointerEvent, widget: Widget, mode: DragMode) => {
    event.stopPropagation();
    event.preventDefault();
    select(widget.id);
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    drag.current = { id: widget.id, mode, x: event.clientX, y: event.clientY, start: widget };
  };

  const move = (event: ReactPointerEvent) => {
    const state = drag.current;
    const bounds = layerRef.current?.getBoundingClientRect();
    if (!state || !bounds) return;
    // The layer turns with the video: the pointer moves along its own (turned) axes.
    const turn = widgetRotation(output);
    const layer = rotatedSize(bounds, turn);
    const moved = unturn(event.clientX - state.x, event.clientY - state.y, turn);
    const dx = moved.x / layer.width;
    const dy = moved.y / layer.height;
    // Alt flips the snap setting for this move.
    const snapping = snap !== event.altKey;
    const tx = SNAP_PX / layer.width;
    const ty = SNAP_PX / layer.height;
    const { start } = state;
    const hit: ActiveLines = { v: null, h: null };

    if (state.mode === 'move') {
      let x = start.x + dx;
      let y = start.y + dy;
      if (snapping) {
        const sx = snapOffset([x, x + start.width / 2, x + start.width], lines.vertical, tx);
        const sy = snapOffset([y, y + start.height / 2, y + start.height], lines.horizontal, ty);
        x += sx.offset;
        y += sy.offset;
        hit.v = sx.line;
        hit.h = sy.line;
      }
      setActive(hit);
      update(state.id, { x: round(x), y: round(y) });
      return;
    }

    let { width, height } = dragResize(start, dx, dy);
    const ratio = getWidgetType(start.type)?.aspectRatio;
    if (snapping) {
      // The dragged edge sits at anchor + (handle - anchor factor) x size.
      const { fx, fy } = anchorFactors(start.anchor);
      const { hx, hy } = resizeCorner(start.anchor);
      const anchor = anchorPoint(start);
      const sx = snapOffset([anchor.x + (hx - fx) * width], lines.vertical, tx);
      if (sx.line !== null) width = (sx.line - anchor.x) / (hx - fx);
      hit.v = sx.line;
      if (!ratio) {
        const sy = snapOffset([anchor.y + (hy - fy) * height], lines.horizontal, ty);
        if (sy.line !== null) height = (sy.line - anchor.y) / (hy - fy);
        hit.h = sy.line;
      }
    }
    width = Math.max(0.01, width);
    // Keep the pixel aspect ratio of square-ish widgets (gauges, maps).
    const frame = widgetFrame(output);
    height = ratio ? (width * frame.width) / (ratio * frame.height) : Math.max(0.01, height);
    setActive(hit);
    const next = resizeAroundAnchor(start, width, height);
    update(state.id, {
      x: round(next.x),
      y: round(next.y),
      width: round(next.width),
      height: round(next.height),
    });
  };

  const end = () => {
    drag.current = null;
    setActive({ v: null, h: null });
  };

  return (
    <div
      ref={layerRef}
      className="widget-handles"
      onPointerDown={() => select(null)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <GuideLines active={active} />
      {widgets.map((widget) => {
        const selected = widget.id === selectedId;
        const { fx, fy } = anchorFactors(widget.anchor);
        const { hx, hy } = resizeCorner(widget.anchor);
        return (
          <div
            key={widget.id}
            className={`widget-box ${selected ? 'selected' : ''} ${errors[widget.id] ? 'has-error' : ''} ${widget.visible ? '' : 'hidden'}`}
            style={{
              left: `${widget.x * 100}%`,
              top: `${widget.y * 100}%`,
              width: `${widget.width * 100}%`,
              height: `${widget.height * 100}%`,
            }}
            title={errors[widget.id] ? `${widget.name}: ${errors[widget.id]}` : widget.name}
            onPointerDown={(e) => begin(e, widget, 'move')}
          >
            {selected && (
              <>
                <div
                  className="widget-anchor"
                  style={{ left: `${fx * 100}%`, top: `${fy * 100}%` }}
                  title={t('template.widgets.anchorTitle', {
                    anchor: t(`template.widgets.anchors.${widget.anchor}`),
                  })}
                />
                <div
                  className="widget-resize"
                  style={{
                    left: `calc(${hx * 100}% - 6px)`,
                    top: `calc(${hy * 100}% - 6px)`,
                    right: 'auto',
                    bottom: 'auto',
                    cursor: hx === hy ? 'nwse-resize' : 'nesw-resize',
                  }}
                  onPointerDown={(e) => begin(e, widget, 'resize')}
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** Overlay with editing handles (template step). */
export function OverlayEditor() {
  const [errors, setErrors] = useState<RenderReport>({});
  const onReport = useMemo(
    () => (report: RenderReport) =>
      setErrors((current) => (JSON.stringify(current) === JSON.stringify(report) ? current : report)),
    [],
  );
  return (
    <>
      <OverlayCanvas editing onReport={onReport} />
      <WidgetHandles errors={errors} />
    </>
  );
}
