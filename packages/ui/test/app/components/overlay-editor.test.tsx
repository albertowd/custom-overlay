import {
  createTemplate,
  createWidget,
  type DataRange,
  dataRangeKey,
  type Widget,
} from '@custom-overlay/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverlayCanvas, OverlayEditor } from '../../../src/app/components/OverlayEditor';
import { useStore } from '../../../src/app/store';
import { FakeResizeObserver } from '../resize-observer';
import {
  FakeImage,
  FakeOffscreenCanvas,
  loadVideoProject,
  recordCanvases,
  resetStore,
  stubRect,
  valuesSnapshot,
} from './canvas-helpers';

const LAYER = { width: 1000, height: 500 };

function setWidgets(
  widgets: Widget[],
  guides: Partial<ReturnType<typeof createTemplate>['guides']> = {},
): void {
  const { project } = useStore.getState();
  const template = createTemplate({ ...project.template, widgets });
  useStore.setState({
    project: { ...project, template: { ...template, guides: { ...template.guides, ...guides } } },
  });
}

const widget = (id: string, overrides: Partial<Widget> = {}) =>
  createWidget('text', { id, name: `Widget ${id}`, x: 0.1, y: 0.1, width: 0.2, height: 0.2, ...overrides });

const stored = (id: string) =>
  useStore.getState().project.template.widgets.find((w) => w.id === id) as Widget;
const layer = () => document.querySelector('.widget-handles') as HTMLElement;
const box = (name: string) => screen.getByTitle(new RegExp(`^${name}`));

/** Render the editor with a laid-out stage. */
function renderEditor() {
  const view = render(
    <div className="stage">
      <OverlayEditor />
    </div>,
  );
  stubRect(layer(), LAYER.width, LAYER.height);
  act(() => FakeResizeObserver.resizeAll(LAYER.width, LAYER.height));
  return view;
}

/** Drag from a point by a pixel offset, on the handles layer (the pointer is captured). */
function drag(target: Element, from: { x: number; y: number }, by: { x: number; y: number }, altKey = false) {
  fireEvent.pointerDown(target, { clientX: from.x, clientY: from.y, pointerId: 1 });
  fireEvent.pointerMove(layer(), { clientX: from.x + by.x, clientY: from.y + by.y, altKey });
}

describe('OverlayEditor', () => {
  beforeEach(() => {
    resetStore();
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    vi.stubGlobal('Image', FakeImage);
    FakeImage.instances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('selection', () => {
    it('selects a widget on the stage and shows its handles, and clears it on the background', () => {
      setWidgets([widget('a'), widget('b', { visible: false })]);
      renderEditor();
      expect(box('Widget b').className).toContain('hidden');
      fireEvent.pointerDown(box('Widget a'), { pointerId: 1 });
      expect(useStore.getState().selectedWidgetId).toBe('a');
      expect(box('Widget a').className).toContain('selected');
      expect(screen.getByTitle('Anchor: top left')).toBeTruthy();
      expect(document.querySelector('.widget-resize')).toBeTruthy();
      fireEvent.pointerUp(layer());
      fireEvent.pointerDown(layer());
      expect(useStore.getState().selectedWidgetId).toBeNull();
      expect(document.querySelector('.widget-resize')).toBeNull();
    });

    it('flags widgets that fail to render', () => {
      setWidgets([widget('bad', { type: 'no-such-type', name: 'Broken' })]);
      renderEditor();
      const flagged = box('Broken');
      expect(flagged.className).toContain('has-error');
      expect(flagged.getAttribute('title')).toBe("Broken: unknown widget type 'no-such-type'");
    });

    it('uses the other diagonal cursor for anchors on the other diagonal', () => {
      setWidgets([widget('a', { anchor: 'top-right' })]);
      renderEditor();
      fireEvent.pointerDown(box('Widget a'), { pointerId: 1 });
      expect((document.querySelector('.widget-resize') as HTMLElement).style.cursor).toBe('nesw-resize');
    });
  });

  describe('moving', () => {
    it('moves the widget with the pointer, without snapping', () => {
      useStore.getState().setSnap(false);
      setWidgets([widget('a')]);
      renderEditor();
      drag(box('Widget a'), { x: 150, y: 100 }, { x: 100, y: 50 });
      expect(stored('a')).toMatchObject({ x: 0.2, y: 0.2, width: 0.2, height: 0.2 });
      fireEvent.pointerUp(layer());
      fireEvent.pointerMove(layer(), { clientX: 900, clientY: 400 });
      expect(stored('a')).toMatchObject({ x: 0.2, y: 0.2 });
    });

    it('moves along the layer axes when the widgets turn with the video', () => {
      useStore.getState().setSnap(false);
      const { project } = useStore.getState();
      const fit = { ...project.output.fit, rotation: 90 as const, rotateWidgets: true };
      useStore.setState({
        project: { ...project, output: { ...project.output, width: 1080, height: 1920, fit } },
      });
      setWidgets([widget('a')]);
      render(
        <div className="stage">
          <OverlayEditor />
        </div>,
      );
      // The 1000 × 500 layer turned clockwise covers 500 × 1000 of the screen.
      stubRect(layer(), 500, 1000);
      // Down the screen is along the layer's width; left is down the layer.
      drag(box('Widget a'), { x: 250, y: 150 }, { x: 0, y: 100 });
      expect(stored('a')).toMatchObject({ x: 0.2, y: 0.1 });
      fireEvent.pointerUp(layer());
      drag(box('Widget a'), { x: 250, y: 250 }, { x: -50, y: 0 });
      expect(stored('a')).toMatchObject({ x: 0.2, y: 0.2 });
    });

    it('snaps an edge to a guide and highlights it, unless Alt is held', () => {
      useStore.getState().setShowGuides(false);
      setWidgets([widget('a')], { columns: 2, rows: 4 });
      renderEditor();
      expect(document.querySelector('.guide-lines')).toBeNull();
      // Left edge to 0.495: 5 px from the middle column line.
      drag(box('Widget a'), { x: 150, y: 100 }, { x: 395, y: 0 });
      expect(stored('a').x).toBe(0.5);
      const active = document.querySelectorAll('.guide.active');
      expect(active).toHaveLength(1);
      expect((active[0] as HTMLElement).style.left).toBe('50%');
      fireEvent.pointerMove(layer(), { clientX: 545, clientY: 100, altKey: true });
      expect(stored('a').x).toBe(0.495);
      fireEvent.pointerCancel(layer());
      expect(document.querySelector('.guide-lines')).toBeNull();
    });

    it('shows every guide when guides are on', () => {
      useStore.getState().setShowGuides(true);
      setWidgets([widget('a')], { columns: 3, rows: 2 });
      renderEditor();
      expect(document.querySelectorAll('.guide.v')).toHaveLength(2);
      expect(document.querySelectorAll('.guide.h')).toHaveLength(1);
      expect(document.querySelectorAll('.guide.active')).toHaveLength(0);
    });

    it('ignores pointer moves without a drag', () => {
      setWidgets([widget('a')]);
      renderEditor();
      fireEvent.pointerMove(layer(), { clientX: 300, clientY: 300 });
      expect(stored('a').x).toBe(0.1);
      expect(useStore.getState().dirty).toBe(false);
    });
  });

  describe('resizing', () => {
    const handle = () => document.querySelector('.widget-resize') as HTMLElement;

    it('resizes from the corner opposite the anchor', () => {
      useStore.getState().setSnap(false);
      setWidgets([widget('a')]);
      renderEditor();
      fireEvent.pointerDown(box('Widget a'), { pointerId: 1 });
      fireEvent.pointerUp(layer());
      drag(handle(), { x: 300, y: 150 }, { x: 100, y: 50 });
      expect(stored('a')).toMatchObject({ x: 0.1, y: 0.1, width: 0.3, height: 0.3 });
      // Never below 1 % of the frame.
      fireEvent.pointerMove(layer(), { clientX: -2000, clientY: -2000 });
      expect(stored('a')).toMatchObject({ width: 0.01, height: 0.01 });
    });

    it('snaps the dragged edges to the guides', () => {
      useStore.getState().setSnap(true);
      setWidgets([widget('a')], { columns: 2, rows: 2 });
      renderEditor();
      fireEvent.pointerDown(box('Widget a'), { pointerId: 1 });
      fireEvent.pointerUp(layer());
      // Right edge to 0.497 and bottom edge to 0.495: both snap to the middle lines.
      drag(handle(), { x: 300, y: 150 }, { x: 197, y: 97.5 });
      expect(stored('a')).toMatchObject({ x: 0.1, y: 0.1, width: 0.4, height: 0.4 });
      expect(document.querySelectorAll('.guide.active')).toHaveLength(2);
    });

    it('keeps the pixel aspect ratio of square widgets', () => {
      useStore.getState().setSnap(true);
      const { output } = useStore.getState().project;
      setWidgets([
        createWidget('speed-gauge', { id: 'g', name: 'Gauge', x: 0.1, y: 0.1, width: 0.2, height: 0.2 }),
      ]);
      renderEditor();
      fireEvent.pointerDown(box('Gauge'), { pointerId: 1 });
      fireEvent.pointerUp(layer());
      drag(handle(), { x: 300, y: 150 }, { x: 100, y: 0 });
      const gauge = stored('g');
      expect(gauge.width).toBe(0.3);
      expect(gauge.height).toBeCloseTo((0.3 * output.width) / output.height, 3);
    });
  });

  describe('rendering', () => {
    it('animates the sample session without a timeline', () => {
      vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
      const drawn = recordCanvases();
      setWidgets([createWidget('value-text', { id: 'v' })]);
      const { unmount } = renderEditor();
      const frames = drawn.count('clearRect');
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(drawn.count('clearRect')).toBeGreaterThan(frames);
      unmount();
    });

    it('draws project values at the playhead, and widgets with their own data range read theirs', () => {
      const drawn = recordCanvases();
      loadVideoProject();
      const range: DataRange = { start: { kind: 'time', time: 1 }, end: null };
      const snapshot = valuesSnapshot({ 'speed.kmh': () => 42 });
      snapshot.ranges = { [dataRangeKey(range)]: { 'speed.kmh': new Float64Array(300).fill(77) } };
      useStore.setState({ values: snapshot, currentTime: 2 });
      setWidgets([
        createWidget('value-text', { id: 'v1', antialias: false }),
        createWidget('value-text', { id: 'v2', antialias: false, dataRange: range }),
      ]);
      renderEditor();
      expect(drawn.texts()).toEqual(expect.arrayContaining(['42 km/h', '77 km/h']));
    });

    it('shows the sample session when asked, but never in the final view', () => {
      const drawn = recordCanvases();
      loadVideoProject();
      useStore.setState({
        values: valuesSnapshot({ 'speed.kmh': () => 42 }),
        sampleData: true,
        testValues: {},
      });
      setWidgets([createWidget('value-text', { id: 'v', antialias: false })]);
      const onReport = vi.fn();
      const { rerender } = render(
        <div>
          <OverlayCanvas editing={false} />
        </div>,
      );
      act(() => FakeResizeObserver.resizeAll(640, 360));
      expect(drawn.texts()).not.toContain('42 km/h');
      rerender(
        <div>
          <OverlayCanvas editing={false} final onReport={onReport} />
        </div>,
      );
      expect(drawn.texts()).toContain('42 km/h');
      expect(onReport).toHaveBeenCalledWith({});
    });

    it('draws test values over the project values while editing', () => {
      const drawn = recordCanvases();
      loadVideoProject();
      useStore.setState({
        values: valuesSnapshot({ 'speed.kmh': () => 42 }),
        testValues: { 'speed.kmh': 99 },
      });
      setWidgets([createWidget('value-text', { id: 'v', antialias: false })]);
      renderEditor();
      expect(drawn.texts()).toContain('99 km/h');
    });

    it('draws anti-aliased widgets through a reused scratch canvas', () => {
      const drawn = recordCanvases();
      FakeOffscreenCanvas.created = 0;
      setWidgets([widget('a', { antialias: true }), widget('b', { antialias: true })]);
      renderEditor();
      expect(FakeOffscreenCanvas.created).toBe(1);
      expect(
        drawn.calls.some((c) => c.method === 'drawImage' && c.args[0] instanceof FakeOffscreenCanvas),
      ).toBe(true);
    });

    it('draws images once they are decoded', () => {
      const drawn = recordCanvases();
      const src = 'data:image/png;base64,AAAA';
      setWidgets([createWidget('image', { id: 'i', antialias: false, props: { src } })]);
      renderEditor();
      const image = FakeImage.instances.find((i) => i.src === src);
      expect(image).toBeTruthy();
      expect(drawn.calls.some((c) => c.method === 'drawImage' && c.args[0] === image)).toBe(false);
      act(() => image?.load());
      expect(drawn.calls.some((c) => c.method === 'drawImage' && c.args[0] === image)).toBe(true);
      expect(FakeImage.instances.filter((i) => i.src === src)).toHaveLength(1);
    });
  });
});
