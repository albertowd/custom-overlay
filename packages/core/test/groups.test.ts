import { describe, expect, it } from 'vitest';
import { createTemplate, parseTemplate, type Template } from '../src/model/project.js';
import type { Widget } from '../src/model/widget.js';
import {
  alignWidgets,
  boundsOf,
  cleanGroups,
  distributeWidgets,
  duplicateGroup,
  framePosition,
  groupBounds,
  groupWidgets,
  layers,
  moveGroup,
  moveLayer,
  removeGroup,
  setWidgetGroup,
  shownPosition,
  siblings,
  ungroupWidgets,
  updateGroup,
} from '../src/widgets/groups.js';
import { createWidget } from '../src/widgets/registry.js';

const box = (id: string, x: number, y: number, width = 0.1, height = 0.1, extra: Partial<Widget> = {}) =>
  createWidget('text', { id, name: id, x, y, width, height, ...extra });

const ids = (template: Template) => template.widgets.map((w) => w.id);
const widget = (template: Template, id: string) => template.widgets.find((w) => w.id === id) as Widget;

/** a (back), b, c, d (front). */
function four(): Template {
  return createTemplate({
    widgets: [box('a', 0.1, 0.1), box('b', 0.3, 0.2), box('c', 0.5, 0.5, 0.2, 0.2), box('d', 0.8, 0.8)],
  });
}

describe('groups', () => {
  it('groups widgets where the front one was, with the origin at their top-left', () => {
    const { template, groupId } = groupWidgets(four(), ['a', 'c'], 'Timing');
    expect(ids(template)).toEqual(['b', 'a', 'c', 'd']);
    expect(template.groups).toEqual([{ id: groupId, name: 'Timing', visible: true, x: 0.1, y: 0.1 }]);
    expect(widget(template, 'a').groupId).toBe(groupId);
    expect(groupBounds(template, groupId as string)).toEqual({ x: 0.1, y: 0.1, width: 0.6, height: 0.6 });
    expect(boundsOf([])).toBeNull();
    // One widget is not a group.
    expect(groupWidgets(four(), ['a', 'nope']).groupId).toBeNull();
  });

  it('takes members out of their previous group, dropping it when empty', () => {
    const first = groupWidgets(four(), ['a', 'b']);
    const second = groupWidgets(first.template, ['a', 'b', 'c']);
    expect(second.template.groups.map((g) => g.id)).toEqual([second.groupId]);
    expect(ids(second.template)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps every group together', () => {
    const first = groupWidgets(four(), ['b', 'c', 'd']);
    // c leaves to join a with d's group cut in two: the group comes back together at its front.
    const split = groupWidgets(first.template, ['a', 'c']);
    const order = ids(split.template);
    expect(order.indexOf('d') - order.indexOf('b')).toBe(1);
    expect(layers(split.template).map((l) => l.kind)).toEqual(['group', 'group']);
  });

  it('cleans members of unknown groups and groups without members', () => {
    const template = createTemplate({
      widgets: [
        box('a', 0, 0, 0.1, 0.1, { groupId: 'g' }),
        box('b', 0, 0),
        box('c', 0, 0, 0.1, 0.1, { groupId: 'x' }),
      ],
      groups: [
        { id: 'g', name: 'G', visible: true, x: 0, y: 0 },
        { id: 'empty', name: 'E', visible: true, x: 0, y: 0 },
      ],
    });
    const clean = cleanGroups(template);
    expect(widget(clean, 'c').groupId).toBeNull();
    expect(clean.groups.map((g) => g.id)).toEqual(['g']);
    expect(cleanGroups(clean)).toBe(clean);
  });

  it('ungroups, joins, leaves, renames, duplicates and removes groups', () => {
    const { template, groupId } = groupWidgets(four(), ['a', 'b']);
    const g = groupId as string;
    expect(ungroupWidgets(template, g).groups).toEqual([]);
    expect(ungroupWidgets(template, g).widgets.every((w) => w.groupId === null)).toBe(true);

    const joined = setWidgetGroup(template, 'd', g);
    expect(ids(joined)).toEqual(['a', 'b', 'd', 'c']);
    expect(setWidgetGroup(template, 'd', 'nope')).toBe(template);
    const left = setWidgetGroup(joined, 'a', null);
    // Just in front of the group it left.
    expect(ids(left)).toEqual(['b', 'd', 'a', 'c']);
    expect(widget(left, 'a').groupId).toBeNull();

    expect(updateGroup(template, g, { name: 'Lap', visible: false }).groups[0]).toMatchObject({
      name: 'Lap',
      visible: false,
    });
    const copy = duplicateGroup(template, g);
    expect(copy.template.groups).toHaveLength(2);
    expect(copy.template.widgets.filter((w) => w.groupId === copy.groupId)).toHaveLength(2);
    expect(duplicateGroup(template, 'nope').groupId).toBeNull();
    expect(ids(removeGroup(template, g))).toEqual(['c', 'd']);
  });

  it('moves the relative members with the group, not the absolute ones', () => {
    const { template, groupId } = groupWidgets(four(), ['a', 'b']);
    const g = groupId as string;
    const pinned = {
      ...template,
      widgets: template.widgets.map((w) => (w.id === 'b' ? { ...w, groupPosition: 'absolute' as const } : w)),
    };
    const moved = moveGroup(pinned, g, 0.05, -0.05);
    expect(widget(moved, 'a')).toMatchObject({ x: 0.15, y: 0.05 });
    expect(widget(moved, 'b')).toMatchObject({ x: 0.3, y: 0.2 });
    expect(moved.groups[0]).toMatchObject({ x: 0.15, y: 0.05 });
  });

  it('shows relative members from the group origin', () => {
    const { template } = groupWidgets(four(), ['a', 'c']);
    const c = widget(template, 'c');
    expect(shownPosition(template, c)).toEqual({ x: 0.4, y: 0.4 });
    expect(framePosition(template, c, { x: 0.4, y: 0.4 })).toEqual({ x: 0.5, y: 0.5 });
    const absolute = { ...c, groupPosition: 'absolute' as const };
    expect(shownPosition(template, absolute)).toEqual({ x: 0.5, y: 0.5 });
    expect(framePosition(template, absolute, { x: 0.2, y: 0.3 })).toEqual({ x: 0.2, y: 0.3 });
    expect(siblings(template, c).map((w) => w.id)).toEqual(['a']);
    expect(siblings(template, widget(template, 'b')).map((w) => w.id)).toEqual(['d']);
  });

  it('moves groups as one layer and members inside their group', () => {
    const { template, groupId } = groupWidgets(four(), ['b', 'c']);
    const g = groupId as string;
    expect(ids(moveLayer(template, { groupId: g }, 1))).toEqual(['a', 'd', 'b', 'c']);
    expect(ids(moveLayer(template, { groupId: g }, -1))).toEqual(['b', 'c', 'a', 'd']);
    // An ungrouped widget jumps over the whole group.
    expect(ids(moveLayer(template, { widgetId: 'a' }, 1))).toEqual(['b', 'c', 'a', 'd']);
    expect(ids(moveLayer(template, { widgetId: 'b' }, 1))).toEqual(['a', 'c', 'b', 'd']);
    // Never out of its group.
    expect(moveLayer(template, { widgetId: 'c' }, 1)).toBe(template);
    expect(moveLayer(template, { widgetId: 'd' }, 1)).toBe(template);
  });

  it('aligns widgets to a box or to the nearest lines', () => {
    const template = four();
    const box = { x: 0, y: 0, width: 1, height: 1 };
    const right = alignWidgets(template, ['a', 'c'], 'right', { kind: 'box', box });
    expect(widget(right, 'a').x).toBe(0.9);
    expect(widget(right, 'c').x).toBe(0.8);
    expect(widget(right, 'b').x).toBe(0.3);
    const middle = alignWidgets(template, ['c'], 'middle', { kind: 'box', box });
    expect(widget(middle, 'c').y).toBe(0.4);
    const lines = { kind: 'lines' as const, vertical: [0, 0.25, 0.5, 1], horizontal: [0, 1] };
    // b's left edge (0.3) goes to 0.25, its centre (0.35) too.
    expect(widget(alignWidgets(template, ['b'], 'left', lines), 'b').x).toBe(0.25);
    expect(widget(alignWidgets(template, ['b'], 'center', lines), 'b').x).toBe(0.2);
    // Its bottom (0.3) is nearer to 0, which would put it out of the frame: 1.
    expect(widget(alignWidgets(template, ['b'], 'bottom', lines), 'b').y).toBe(0.9);
    const none = alignWidgets(template, ['b'], 'top', { kind: 'lines', vertical: [], horizontal: [] });
    expect(widget(none, 'b').y).toBe(0.2);
  });

  it('spreads widgets with equal gaps', () => {
    const template = createTemplate({
      widgets: [box('a', 0, 0, 0.1), box('b', 0.15, 0, 0.2), box('c', 0.9, 0, 0.1)],
    });
    const spread = distributeWidgets(template, ['a', 'b', 'c'], 'horizontal');
    // 1 wide, 0.4 of widgets: two gaps of 0.3.
    expect(widget(spread, 'b').x).toBe(0.4);
    expect(widget(spread, 'a').x).toBe(0);
    expect(distributeWidgets(template, ['a', 'b'], 'horizontal')).toBe(template);
    const vertical = distributeWidgets(
      createTemplate({ widgets: [box('a', 0, 0), box('b', 0, 0.5), box('c', 0, 0.2)] }),
      ['a', 'b', 'c'],
      'vertical',
    );
    expect(widget(vertical, 'c').y).toBe(0.25);
  });

  it('reads templates without groups, and widgets without a group', () => {
    const parsed = parseTemplate({ version: 1, widgets: [{ id: 'w', type: 'text' }] });
    expect(parsed.groups).toEqual([]);
    expect(parsed.widgets[0]).toMatchObject({ groupId: null, groupPosition: 'relative' });
  });
});
