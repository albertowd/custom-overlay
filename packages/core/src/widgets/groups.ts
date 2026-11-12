import type { Rect } from '../export/canvas.js';
import { createId, type Template } from '../model/project.js';
import type { Widget, WidgetGroup } from '../model/widget.js';
import { anchorPoint } from './layout.js';

/**
 * Widget groups. Members of a group sit next to each other in the widget order (the group is
 * drawn as one layer), and their positions stay stored in the frame: moving a group moves its
 * relative members and its origin, the point their positions are shown from.
 */

type Box = Pick<Widget, 'x' | 'y' | 'width' | 'height'>;

/** Box around boxes, null without any. */
export function boundsOf(boxes: readonly Box[]): Rect | null {
  if (boxes.length === 0) return null;
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const box of boxes) {
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Rounded like the editor stores positions. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function findGroup(
  template: Pick<Template, 'groups'>,
  groupId: string | null,
): WidgetGroup | undefined {
  return groupId === null ? undefined : template.groups.find((g) => g.id === groupId);
}

/** Members of a group, back to front. */
export function groupMembers(template: Pick<Template, 'widgets'>, groupId: string): Widget[] {
  return template.widgets.filter((w) => w.groupId === groupId);
}

/** Box around a group's members, null when it has none. */
export function groupBounds(template: Pick<Template, 'widgets'>, groupId: string): Rect | null {
  return boundsOf(groupMembers(template, groupId));
}

/** Widgets sharing a widget's group (all the ungrouped ones for an ungrouped widget), without it. */
export function siblings(template: Pick<Template, 'widgets'>, widget: Widget): Widget[] {
  return template.widgets.filter((w) => w.id !== widget.id && w.groupId === widget.groupId);
}

/**
 * Where a widget's anchor sits: from its group origin when it is a relative member of a group,
 * in the frame otherwise.
 */
export function shownPosition(template: Pick<Template, 'groups'>, widget: Widget): { x: number; y: number } {
  const point = anchorPoint(widget);
  const group = widget.groupPosition === 'relative' ? findGroup(template, widget.groupId) : undefined;
  return group ? { x: point.x - group.x, y: point.y - group.y } : point;
}

/** The frame position of an anchor shown at `shown` (see `shownPosition`). */
export function framePosition(
  template: Pick<Template, 'groups'>,
  widget: Widget,
  shown: { x: number; y: number },
): { x: number; y: number } {
  const group = widget.groupPosition === 'relative' ? findGroup(template, widget.groupId) : undefined;
  return group ? { x: shown.x + group.x, y: shown.y + group.y } : shown;
}

/**
 * Groups made consistent: members of unknown groups leave them, groups without members go, and
 * each group's members are put together where its front member is.
 */
export function cleanGroups(template: Template): Template {
  const known = new Set(template.groups.map((g) => g.id));
  const widgets = template.widgets.map((w) =>
    w.groupId !== null && !known.has(w.groupId) ? { ...w, groupId: null } : w,
  );
  const front = new Map<string, number>();
  widgets.forEach((w, i) => {
    if (w.groupId !== null) front.set(w.groupId, i);
  });
  const ordered: Widget[] = [];
  widgets.forEach((w, i) => {
    if (w.groupId === null) ordered.push(w);
    else if (front.get(w.groupId) === i) ordered.push(...widgets.filter((m) => m.groupId === w.groupId));
  });
  const used = new Set(front.keys());
  const groups = template.groups.filter((g) => used.has(g.id));
  const same = groups.length === template.groups.length && ordered.every((w, i) => w === template.widgets[i]);
  return same ? template : { ...template, widgets: ordered, groups };
}

/**
 * Group widgets (members of other groups leave them). The group sits where the front one was,
 * with its origin at the top-left of the members. Fewer than two known widgets: unchanged.
 */
export function groupWidgets(
  template: Template,
  ids: readonly string[],
  name = 'Group',
): { template: Template; groupId: string | null } {
  const chosen = new Set(ids);
  const members = template.widgets.filter((w) => chosen.has(w.id));
  const bounds = boundsOf(members);
  if (members.length < 2 || !bounds) return { template, groupId: null };
  const group: WidgetGroup = {
    id: createId('g'),
    name,
    visible: true,
    x: round(bounds.x),
    y: round(bounds.y),
  };
  let frontIndex = -1;
  template.widgets.forEach((w, i) => {
    if (chosen.has(w.id)) frontIndex = i;
  });
  const below = template.widgets.slice(0, frontIndex).filter((w) => !chosen.has(w.id));
  const above = template.widgets.slice(frontIndex + 1);
  const grouped = members.map((w) => ({ ...w, groupId: group.id }));
  return {
    template: cleanGroups({
      ...template,
      widgets: [...below, ...grouped, ...above],
      groups: [...template.groups, group],
    }),
    groupId: group.id,
  };
}

/** Remove a group; its members stay where they are, on their own. */
export function ungroupWidgets(template: Template, groupId: string): Template {
  return {
    ...template,
    widgets: template.widgets.map((w) => (w.groupId === groupId ? { ...w, groupId: null } : w)),
    groups: template.groups.filter((g) => g.id !== groupId),
  };
}

/** Put a widget in a group (at its front), or take it out of its group with null. */
export function setWidgetGroup(template: Template, widgetId: string, groupId: string | null): Template {
  const widget = template.widgets.find((w) => w.id === widgetId);
  if (!widget || widget.groupId === groupId) return template;
  if (groupId !== null && !findGroup(template, groupId)) return template;
  const moved = { ...widget, groupId };
  const rest = template.widgets.filter((w) => w.id !== widgetId);
  let at = rest.length;
  if (groupId === null) {
    // Leaving a group: just above it, so it stays where it shows.
    const index = template.widgets.findIndex((w) => w.id === widgetId);
    const after = template.widgets.findIndex((w, i) => i > index && w.groupId !== widget.groupId);
    at = after < 0 ? rest.length : after - 1;
  } else {
    rest.forEach((w, i) => {
      if (w.groupId === groupId) at = i + 1;
    });
  }
  return cleanGroups({ ...template, widgets: [...rest.slice(0, at), moved, ...rest.slice(at)] });
}

/** Rename, hide or show a group. */
export function updateGroup(
  template: Template,
  groupId: string,
  patch: Partial<Pick<WidgetGroup, 'name' | 'visible'>>,
): Template {
  return { ...template, groups: template.groups.map((g) => (g.id === groupId ? { ...g, ...patch } : g)) };
}

/** Move widgets by an offset (fractions of the frame). */
export function moveWidgetsBy(template: Template, ids: readonly string[], dx: number, dy: number): Template {
  const moving = new Set(ids);
  return {
    ...template,
    widgets: template.widgets.map((w) =>
      moving.has(w.id) ? { ...w, x: round(w.x + dx), y: round(w.y + dy) } : w,
    ),
  };
}

/** Move a group: its origin and its relative members (absolute members stay). */
export function moveGroup(template: Template, groupId: string, dx: number, dy: number): Template {
  const ids = groupMembers(template, groupId)
    .filter((w) => w.groupPosition === 'relative')
    .map((w) => w.id);
  const moved = moveWidgetsBy(template, ids, dx, dy);
  return {
    ...moved,
    groups: moved.groups.map((g) =>
      g.id === groupId ? { ...g, x: round(g.x + dx), y: round(g.y + dy) } : g,
    ),
  };
}

/** Copy a group with its members (new ids), in front of everything. */
export function duplicateGroup(
  template: Template,
  groupId: string,
): { template: Template; groupId: string | null } {
  const group = findGroup(template, groupId);
  if (!group) return { template, groupId: null };
  const copy: WidgetGroup = { ...group, id: createId('g'), name: `${group.name} copy` };
  const members = groupMembers(template, groupId).map((w) => ({ ...w, id: createId('w'), groupId: copy.id }));
  return {
    template: { ...template, widgets: [...template.widgets, ...members], groups: [...template.groups, copy] },
    groupId: copy.id,
  };
}

/** Remove a group and its members. */
export function removeGroup(template: Template, groupId: string): Template {
  return {
    ...template,
    widgets: template.widgets.filter((w) => w.groupId !== groupId),
    groups: template.groups.filter((g) => g.id !== groupId),
  };
}

/** A layer of the widget list: a widget on its own, or a group with its members (back to front). */
export type Layer =
  | { kind: 'widget'; widget: Widget }
  | { kind: 'group'; group: WidgetGroup; widgets: Widget[] };

/** The widgets as layers, back to front (members of a group listed apart become separate layers). */
export function layers(template: Pick<Template, 'widgets' | 'groups'>): Layer[] {
  const result: Layer[] = [];
  for (const widget of template.widgets) {
    const group = findGroup(template, widget.groupId);
    const last = result[result.length - 1];
    if (!group) result.push({ kind: 'widget', widget });
    else if (last?.kind === 'group' && last.group.id === group.id) last.widgets.push(widget);
    else result.push({ kind: 'group', group, widgets: [widget] });
  }
  return result;
}

/**
 * Move a widget or a group one layer to the front (1) or the back (-1). A group moves as a whole
 * past the next layer; a member moves inside its group.
 */
export function moveLayer(
  template: Template,
  target: { widgetId: string } | { groupId: string },
  direction: 1 | -1,
): Template {
  const all = layers(template);
  const swap = <T>(items: T[], index: number): T[] | null => {
    const other = index + direction;
    if (index < 0 || other < 0 || other >= items.length) return null;
    const next = [...items];
    [next[index], next[other]] = [next[other] as T, next[index] as T];
    return next;
  };
  const flatten = (list: Layer[]) => list.flatMap((l) => (l.kind === 'widget' ? [l.widget] : l.widgets));
  let reordered: Layer[] | null = null;
  if ('groupId' in target) {
    reordered = swap(
      all,
      all.findIndex((l) => l.kind === 'group' && l.group.id === target.groupId),
    );
  } else {
    const index = all.findIndex((l) =>
      l.kind === 'widget' ? l.widget.id === target.widgetId : l.widgets.some((w) => w.id === target.widgetId),
    );
    const layer = all[index];
    if (layer?.kind === 'widget') reordered = swap(all, index);
    else if (layer) {
      const members = swap(
        layer.widgets,
        layer.widgets.findIndex((w) => w.id === target.widgetId),
      );
      if (members) reordered = all.map((l, i) => (i === index ? { ...layer, widgets: members } : l));
    }
  }
  return reordered ? { ...template, widgets: flatten(reordered) } : template;
}

export type AlignEdge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

/** What widgets align to: a box (their group, the selection, the frame) or the nearest snap line. */
export type AlignReference =
  | { kind: 'box'; box: Rect }
  | { kind: 'lines'; vertical: number[]; horizontal: number[] };

const HORIZONTAL_EDGES: readonly AlignEdge[] = ['left', 'center', 'right'];

/** Where on a box an edge is: 0 = left / top, 0.5 = middle, 1 = right / bottom. */
function edgeFactor(edge: AlignEdge): number {
  return edge === 'left' || edge === 'top' ? 0 : edge === 'right' || edge === 'bottom' ? 1 : 0.5;
}

/**
 * The line nearest to an edge at `point`, among those keeping the box (`size` long, the edge at
 * `factor` of it) inside the frame when there are any.
 */
function nearestLine(lines: readonly number[], point: number, size: number, factor: number): number | null {
  const inside = lines.filter(
    (line) => line - factor * size >= -1e-9 && line + (1 - factor) * size <= 1 + 1e-9,
  );
  let best: number | null = null;
  for (const line of inside.length > 0 ? inside : lines) {
    if (best === null || Math.abs(line - point) < Math.abs(best - point)) best = line;
  }
  return best;
}

/** Align widgets' edges (or centres) to a reference. */
export function alignWidgets(
  template: Template,
  ids: readonly string[],
  edge: AlignEdge,
  reference: AlignReference,
): Template {
  const chosen = new Set(ids);
  const horizontal = HORIZONTAL_EDGES.includes(edge);
  const f = edgeFactor(edge);
  return {
    ...template,
    widgets: template.widgets.map((w) => {
      if (!chosen.has(w.id)) return w;
      const size = horizontal ? w.width : w.height;
      const start = horizontal ? w.x : w.y;
      let target: number | null;
      if (reference.kind === 'box') {
        const { box } = reference;
        target = horizontal ? box.x + f * box.width : box.y + f * box.height;
      } else {
        target = nearestLine(
          horizontal ? reference.vertical : reference.horizontal,
          start + f * size,
          size,
          f,
        );
      }
      if (target === null) return w;
      const value = round(target - f * size);
      return horizontal ? { ...w, x: value } : { ...w, y: value };
    }),
  };
}

/**
 * Spread widgets so the gaps between them are equal, the first and last ones staying put (by
 * their position along the axis). Needs three widgets or more.
 */
export function distributeWidgets(
  template: Template,
  ids: readonly string[],
  axis: 'horizontal' | 'vertical',
): Template {
  const chosen = template.widgets.filter((w) => ids.includes(w.id));
  if (chosen.length < 3) return template;
  const start = (w: Widget) => (axis === 'horizontal' ? w.x : w.y);
  const size = (w: Widget) => (axis === 'horizontal' ? w.width : w.height);
  const sorted = [...chosen].sort((a, b) => start(a) + size(a) / 2 - (start(b) + size(b) / 2));
  const first = sorted[0] as Widget;
  const last = sorted[sorted.length - 1] as Widget;
  const span = start(last) + size(last) - start(first);
  const gap = (span - sorted.reduce((sum, w) => sum + size(w), 0)) / (sorted.length - 1);
  const placed = new Map<string, number>();
  let at = start(first);
  for (const w of sorted) {
    placed.set(w.id, round(at));
    at += size(w) + gap;
  }
  return {
    ...template,
    widgets: template.widgets.map((w) => {
      const value = placed.get(w.id);
      if (value === undefined || w === first || w === last) return w;
      return axis === 'horizontal' ? { ...w, x: value } : { ...w, y: value };
    }),
  };
}
