import { DEFAULT_TRACK, type Gate, type Track } from '@custom-overlay/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type LineTarget, TrackMap } from '../../../src/app/components/TrackMap';
import { FakeResizeObserver } from '../resize-observer';
import { circlePath, FakeImage, recordCanvases, stubRect } from './canvas-helpers';

const SIZE = 400;
const CENTRE = { latitude: 45, longitude: 7 };

/** Start/finish from the path centre straight north; one split line south of it. */
const TRACK: Track = {
  ...DEFAULT_TRACK,
  startFinish: { a: CENTRE, b: { latitude: 45.001, longitude: 7 } },
  sectors: [{ a: { latitude: 44.999, longitude: 7.001 }, b: { latitude: 44.999, longitude: 6.999 } }],
};

interface Props {
  latitude?: Float64Array;
  longitude?: Float64Array;
  track?: Track;
  position?: number;
  drawing?: LineTarget | null;
  satellite?: boolean;
  onDraw?: (target: LineTarget, gate: Gate) => void;
  onMove?: (target: LineTarget, gate: Gate) => void;
}

function renderMap(props: Props = {}, centre = CENTRE) {
  const path = circlePath(400, centre);
  const all = {
    latitude: path.latitude,
    longitude: path.longitude,
    track: TRACK,
    position: -1,
    drawing: null,
    satellite: false,
    onDraw: vi.fn(),
    onMove: vi.fn(),
    ...props,
  };
  const view = render(<TrackMap {...all} />);
  const canvas = document.querySelector('canvas') as HTMLCanvasElement;
  if (canvas) {
    stubRect(canvas, SIZE, SIZE);
    act(() => FakeResizeObserver.resizeAll(SIZE, SIZE));
  }
  return {
    ...view,
    canvas,
    props: all,
    rerenderWith: (more: Props) => view.rerender(<TrackMap {...all} {...more} />),
  };
}

const at = (x: number, y: number) => ({ clientX: x, clientY: y, pointerId: 1 });

describe('TrackMap', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('says when there is no GPS position to draw', () => {
    const empty = new Float64Array([Number.NaN, 0]);
    renderMap({ latitude: empty, longitude: new Float64Array([Number.NaN, 0]) });
    expect(screen.getByText('No GPS positions to draw.')).toBeTruthy();
    expect(document.querySelector('canvas')).toBeNull();
  });

  it('draws the path, the labelled lines and the playhead marker', () => {
    const drawn = recordCanvases();
    const { canvas, rerenderWith } = renderMap({ position: -1 });
    expect(canvas.style.width).toBe(`${SIZE}px`);
    expect(drawn.texts()).toEqual(expect.arrayContaining(['S/F', 'Split 1']));
    expect(drawn.count('lineTo')).toBeGreaterThan(100);
    const arcs = drawn.count('arc');
    rerenderWith({ position: 10 });
    // Four line handles each draw, plus the marker.
    expect(drawn.count('arc') - arcs).toBe(5);
    const before = drawn.count('arc');
    rerenderWith({ position: 100_000 });
    expect(drawn.count('arc') - before).toBe(4);
  });

  it('skips gaps in the path and draws a track without lines', () => {
    const drawn = recordCanvases();
    const path = circlePath(40);
    path.latitude[5] = Number.NaN;
    renderMap({ ...path, track: DEFAULT_TRACK });
    // Pen lifted at the gap: a second moveTo for the path.
    expect(drawn.count('moveTo')).toBeGreaterThanOrEqual(2);
    expect(drawn.texts()).toEqual([]);
  });

  it('places a new line with two clicks, previewing it dashed', () => {
    const drawn = recordCanvases();
    const onDraw = vi.fn();
    const { canvas } = renderMap({ drawing: 1, onDraw });
    fireEvent.pointerMove(canvas, at(200, 200));
    expect(canvas.style.cursor).toBe('crosshair');
    fireEvent.pointerDown(canvas, at(200, 200));
    expect(onDraw).not.toHaveBeenCalled();
    fireEvent.pointerMove(canvas, at(260, 200));
    expect(drawn.calls.some((c) => c.method === 'setLineDash' && (c.args[0] as number[]).length === 2)).toBe(
      true,
    );
    fireEvent.pointerDown(canvas, at(260, 200));
    expect(onDraw).toHaveBeenCalledTimes(1);
    const [target, gate] = onDraw.mock.calls[0] as [LineTarget, Gate];
    expect(target).toBe(1);
    expect(gate.a.latitude).toBeCloseTo(45, 5);
    expect(gate.a.longitude).toBeCloseTo(7, 5);
    expect(gate.b.longitude).toBeGreaterThan(7);
    expect(gate.b.latitude).toBeCloseTo(45, 5);
    fireEvent.pointerLeave(canvas);
  });

  it('previews the start/finish line and forgets the first click when the mode changes', () => {
    const drawn = recordCanvases();
    const onDraw = vi.fn();
    const { canvas, rerenderWith } = renderMap({ drawing: 'start', onDraw });
    fireEvent.pointerDown(canvas, at(100, 100));
    fireEvent.pointerMove(canvas, at(120, 100));
    expect(drawn.calls.some((c) => c.method === 'setLineDash' && (c.args[0] as number[]).length === 2)).toBe(
      true,
    );
    rerenderWith({ drawing: null });
    rerenderWith({ drawing: 'start' });
    fireEvent.pointerDown(canvas, at(300, 300));
    expect(onDraw).not.toHaveBeenCalled();
  });

  it('drags a line end to a new place', () => {
    const onMove = vi.fn();
    const { canvas } = renderMap({ onMove });
    // The start/finish line's first end is at the path centre: the canvas centre.
    fireEvent.pointerMove(canvas, at(201, 199));
    expect(canvas.style.cursor).toBe('move');
    fireEvent.pointerDown(canvas, at(201, 199));
    fireEvent.pointerMove(canvas, at(240, 200));
    expect(onMove).toHaveBeenCalledTimes(1);
    const [target, gate] = onMove.mock.calls[0] as [LineTarget, Gate];
    expect(target).toBe('start');
    expect(gate.a.longitude).toBeGreaterThan(7);
    expect(gate.b).toEqual(TRACK.startFinish?.b);
    fireEvent.pointerUp(canvas);
    fireEvent.pointerMove(canvas, at(260, 200));
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it('pans with a drag on the map and zooms around the cursor', () => {
    const onMove = vi.fn();
    const { canvas } = renderMap({ onMove });
    fireEvent.pointerMove(canvas, at(20, 20));
    expect(canvas.style.cursor).toBe('grab');
    // Pan right by 50 px: the centre handle follows.
    fireEvent.pointerDown(canvas, at(20, 20));
    fireEvent.pointerMove(canvas, at(70, 20));
    fireEvent.pointerUp(canvas);
    expect(onMove).not.toHaveBeenCalled();
    fireEvent.pointerMove(canvas, at(250, 200));
    expect(canvas.style.cursor).toBe('move');
    fireEvent.pointerMove(canvas, at(200, 200));
    expect(canvas.style.cursor).toBe('grab');
    // Zooming in around the handle keeps it under the cursor.
    fireEvent.wheel(canvas, { clientX: 250, clientY: 200, deltaY: -100 });
    fireEvent.pointerMove(canvas, at(250, 200));
    expect(canvas.style.cursor).toBe('move');
    // Zooming out elsewhere moves it away from the cursor.
    fireEvent.wheel(canvas, { clientX: 20, clientY: 20, deltaY: 100 });
    fireEvent.wheel(canvas, { clientX: 20, clientY: 20, deltaY: 100 });
    fireEvent.pointerMove(canvas, at(250, 200));
    expect(canvas.style.cursor).toBe('grab');
  });

  it('draws satellite tiles as they arrive, with the attribution', () => {
    vi.stubGlobal('Image', FakeImage);
    FakeImage.instances = [];
    const drawn = recordCanvases();
    const { rerenderWith } = renderMap({ satellite: true }, { latitude: 40, longitude: -3 });
    expect(FakeImage.instances.length).toBeGreaterThan(0);
    expect(FakeImage.instances[0]?.src).toMatch(/World_Imagery\/MapServer\/tile\/\d+\/\d+\/\d+$/);
    expect(drawn.texts().some((t) => t.startsWith('Powered by Esri'))).toBe(true);
    expect(drawn.count('drawImage')).toBe(0);
    act(() => {
      for (const image of FakeImage.instances) image.load();
    });
    expect(drawn.count('drawImage')).toBeGreaterThan(0);
    // Zoomed in, the finer tiles are not there yet: the loaded coarser ones fill in.
    const loaded = FakeImage.instances.length;
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    fireEvent.wheel(canvas, { clientX: 200, clientY: 200, deltaY: -100 });
    fireEvent.wheel(canvas, { clientX: 200, clientY: 200, deltaY: -100 });
    fireEvent.wheel(canvas, { clientX: 200, clientY: 200, deltaY: -100 });
    fireEvent.wheel(canvas, { clientX: 200, clientY: 200, deltaY: -100 });
    expect(FakeImage.instances.length).toBeGreaterThan(loaded);
    const before = drawn.count('drawImage');
    rerenderWith({ satellite: true, position: 3 });
    expect(drawn.count('drawImage')).toBeGreaterThan(before);
  });

  it('says when the imagery cannot be downloaded', () => {
    vi.stubGlobal('Image', FakeImage);
    FakeImage.instances = [];
    const drawn = recordCanvases();
    renderMap({ satellite: true }, { latitude: -33, longitude: 151 });
    act(() => {
      for (const image of FakeImage.instances) image.fail();
    });
    expect(drawn.texts()).toContain('Satellite imagery unavailable (no internet?)');
  });

  it('caps the tiles of a huge view by using a coarser zoom', () => {
    vi.stubGlobal('Image', FakeImage);
    FakeImage.instances = [];
    // A path a few metres long, zoomed far out: many fine tiles would be needed.
    const { canvas } = renderMap({ satellite: true }, { latitude: 10, longitude: 10 });
    for (let i = 0; i < 25; i++) fireEvent.wheel(canvas, { clientX: 200, clientY: 200, deltaY: 100 });
    const zooms = new Set(FakeImage.instances.map((image) => Number(image.src.split('/').at(-3))));
    expect(Math.min(...zooms)).toBeLessThan(Math.max(...zooms));
    expect(FakeImage.instances.length).toBeLessThan(1000);
  });
});
