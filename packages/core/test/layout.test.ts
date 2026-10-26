import { describe, expect, it } from 'vitest';
import { GuidesSchema } from '../src/model/project.js';
import { WidgetSchema } from '../src/model/widget.js';
import {
  anchorPoint,
  dragResize,
  guideLines,
  placeAnchor,
  resizeAroundAnchor,
  resizeCorner,
  snapOffset,
} from '../src/widgets/layout.js';

const box = (anchor: string) =>
  ({ x: 0.1, y: 0.2, width: 0.4, height: 0.2, anchor }) as Parameters<typeof anchorPoint>[0];

describe('anchors', () => {
  it('defaults to the top-left corner for existing widgets', () => {
    expect(WidgetSchema.parse({ id: 'w', type: 'text' }).anchor).toBe('top-left');
  });

  it('positions a widget by its anchor', () => {
    expect(anchorPoint(box('top-left'))).toEqual({ x: 0.1, y: 0.2 });
    expect(anchorPoint(box('center'))).toEqual({ x: 0.30000000000000004, y: 0.30000000000000004 });
    expect(anchorPoint(box('bottom-right'))).toEqual({ x: 0.5, y: 0.4 });
    expect(anchorPoint(box('top'))).toMatchObject({ y: 0.2 });
    // Centre a widget: anchor centre at 50 %.
    const centred = placeAnchor(box('center'), { x: 0.5, y: 0.5 });
    expect(centred.x).toBeCloseTo(0.3, 10);
    expect(centred.y).toBeCloseTo(0.4, 10);
    // Right edge at 98 %.
    expect(placeAnchor(box('right'), { x: 0.98, y: 0.5 }).x).toBeCloseTo(0.58, 10);
  });

  it('keeps the anchor in place when resizing', () => {
    const grown = resizeAroundAnchor(box('center'), 0.6, 0.4);
    expect(grown.x).toBeCloseTo(0, 10);
    expect(grown.y).toBeCloseTo(0.1, 10);
    const right = resizeAroundAnchor(box('bottom-right'), 0.2, 0.1);
    expect(right.x + right.width).toBeCloseTo(0.5, 10);
    expect(right.y + right.height).toBeCloseTo(0.4, 10);
  });

  it('drags the handle opposite the anchor', () => {
    expect(resizeCorner('top-left')).toEqual({ hx: 1, hy: 1 });
    expect(resizeCorner('bottom-right')).toEqual({ hx: 0, hy: 0 });
    expect(resizeCorner('center')).toEqual({ hx: 1, hy: 1 });
    expect(dragResize(box('top-left'), 0.1, 0.05)).toEqual({ width: 0.5, height: 0.25 });
    // Centred: the box grows on both sides, twice the pointer move.
    const centred = dragResize(box('center'), 0.1, 0.05);
    expect(centred.width).toBeCloseTo(0.6, 10);
    expect(centred.height).toBeCloseTo(0.3, 10);
    // Right anchor: the handle is on the left, dragging left grows.
    expect(dragResize(box('right'), -0.1, 0).width).toBeCloseTo(0.5, 10);
  });
});

describe('snap lines', () => {
  it('lists divisions, margins and extra lines with the frame edges', () => {
    const guides = GuidesSchema.parse({ columns: 3, rows: 2, margin: 5, vertical: [80], horizontal: [] });
    const lines = guideLines(guides);
    expect(lines.vertical).toEqual([0, 0.05, 0.333333, 0.666667, 0.8, 0.95, 1]);
    expect(lines.horizontal).toEqual([0, 0.05, 0.5, 0.95, 1]);
    expect(guideLines(GuidesSchema.parse({}))).toEqual({ vertical: [0, 1], horizontal: [0, 1] });
  });

  it('snaps the closest point within the threshold', () => {
    // Left 0.1, centre 0.3, right 0.5; line at 0.505 is closest to the right edge.
    expect(snapOffset([0.1, 0.3, 0.5], [0.505, 0.9], 0.01)).toEqual({ offset: 0.505 - 0.5, line: 0.505 });
    expect(snapOffset([0.1, 0.3, 0.5], [0.7], 0.01)).toEqual({ offset: 0, line: null });
  });
});
