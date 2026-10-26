import type { Guides } from '../model/project.js';
import type { Widget, WidgetAnchor } from '../model/widget.js';

/**
 * Widget placement in fractions of the output frame. A widget is stored by its top-left corner;
 * its anchor is the point the editor positions it by and keeps fixed when resizing.
 */

/** Where an anchor sits in the widget box: 0 = left / top, 0.5 = middle, 1 = right / bottom. */
export function anchorFactors(anchor: WidgetAnchor): { fx: number; fy: number } {
  const fx = anchor.endsWith('left') ? 0 : anchor.endsWith('right') ? 1 : 0.5;
  const fy = anchor.startsWith('top') ? 0 : anchor.startsWith('bottom') ? 1 : 0.5;
  return { fx, fy };
}

type Box = Pick<Widget, 'x' | 'y' | 'width' | 'height' | 'anchor'>;

/** The anchor's position in the frame. */
export function anchorPoint(widget: Box): { x: number; y: number } {
  const { fx, fy } = anchorFactors(widget.anchor);
  return { x: widget.x + fx * widget.width, y: widget.y + fy * widget.height };
}

/** Top-left corner that puts the anchor at a point. */
export function placeAnchor(widget: Box, point: { x: number; y: number }): { x: number; y: number } {
  const { fx, fy } = anchorFactors(widget.anchor);
  return { x: point.x - fx * widget.width, y: point.y - fy * widget.height };
}

/** New size with the anchor kept in place. */
export function resizeAroundAnchor(
  widget: Box,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  const point = anchorPoint(widget);
  return { ...placeAnchor({ ...widget, width, height }, point), width, height };
}

/**
 * Corner the resize handle sits on: opposite the anchor (the bottom-right one for a centred
 * anchor), as fractions of the box.
 */
export function resizeCorner(anchor: WidgetAnchor): { hx: 0 | 1; hy: 0 | 1 } {
  const { fx, fy } = anchorFactors(anchor);
  return { hx: fx > 0.5 ? 0 : 1, hy: fy > 0.5 ? 0 : 1 };
}

/**
 * Size after dragging the resize handle by (dx, dy): the handle follows the pointer while the
 * anchor stays put (a centred widget grows on both sides).
 */
export function dragResize(widget: Box, dx: number, dy: number): { width: number; height: number } {
  const { fx, fy } = anchorFactors(widget.anchor);
  const { hx, hy } = resizeCorner(widget.anchor);
  const spanX = Math.abs(hx - fx);
  const spanY = Math.abs(hy - fy);
  const sx = hx === 1 ? 1 : -1;
  const sy = hy === 1 ? 1 : -1;
  return {
    width: (spanX * widget.width + sx * dx) / spanX,
    height: (spanY * widget.height + sy * dy) / spanY,
  };
}

/** Positions of the snap lines (fractions, sorted, frame edges included). */
export function guideLines(guides: Guides): { vertical: number[]; horizontal: number[] } {
  const lines = (divisions: number, extra: readonly number[]) => {
    const all = [0, 1, ...extra.map((p) => p / 100)];
    for (let k = 1; k < divisions; k++) all.push(k / divisions);
    if (guides.margin > 0) all.push(guides.margin / 100, 1 - guides.margin / 100);
    return [...new Set(all.filter((v) => v >= 0 && v <= 1).map((v) => Math.round(v * 1e6) / 1e6))].sort(
      (a, b) => a - b,
    );
  };
  return {
    vertical: lines(guides.columns, guides.vertical),
    horizontal: lines(guides.rows, guides.horizontal),
  };
}

/**
 * The shift that brings the closest of `points` onto one of `lines`, if within `threshold`;
 * 0 (and no line) otherwise.
 */
export function snapOffset(
  points: readonly number[],
  lines: readonly number[],
  threshold: number,
): { offset: number; line: number | null } {
  let best = { offset: 0, line: null as number | null, distance: threshold };
  for (const point of points) {
    for (const line of lines) {
      const distance = Math.abs(line - point);
      if (distance <= best.distance) best = { offset: line - point, line, distance };
    }
  }
  return { offset: best.offset, line: best.line };
}
