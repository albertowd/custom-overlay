import { createTemplate, createWidget, type Template, type Widget } from '@custom-overlay/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverlayEditor } from '../../../src/app/components/OverlayEditor';
import { WidgetInspector, WidgetList } from '../../../src/app/components/WidgetsPanel';
import { TemplateStep } from '../../../src/app/steps/TemplateStep';
import { useStore } from '../../../src/app/store';
import { FakeResizeObserver } from '../resize-observer';
import { FakeImage, FakeOffscreenCanvas, resetStore, stubRect } from './canvas-helpers';

const state = () => useStore.getState();
const template = () => state().project.template;
const stored = (id: string) => template().widgets.find((w) => w.id === id) as Widget;
const ids = () => template().widgets.map((w) => w.id);

const widget = (id: string, x: number, y: number, overrides: Partial<Widget> = {}) =>
  createWidget('text', { id, name: `Widget ${id}`, x, y, width: 0.1, height: 0.1, ...overrides });

function setTemplate(overrides: Partial<Template>): void {
  const { project } = state();
  useStore.setState({
    project: { ...project, template: createTemplate({ ...project.template, ...overrides }) },
  });
}

/** a, b, c on their own; a and b get grouped by the tests. */
function threeWidgets(): void {
  setTemplate({ widgets: [widget('a', 0.1, 0.1), widget('b', 0.3, 0.2), widget('c', 0.6, 0.6)] });
}

function groupAB(): string {
  act(() => {
    state().selectWidget('a');
    state().selectWidget('b', 'toggle');
    state().groupSelection();
  });
  return state().selectedGroupId as string;
}

beforeEach(() => {
  resetStore();
  localStorage.clear();
});

describe('selection and groups in the store', () => {
  it('selects several widgets and groups them, selecting the group', () => {
    threeWidgets();
    act(() => state().selectWidget('a'));
    act(() => state().selectWidget('b', 'toggle'));
    expect(state().selectedWidgetIds).toEqual(['a', 'b']);
    expect(state().selectedWidgetId).toBe('b');
    act(() => state().selectWidget('b', 'toggle'));
    expect(state().selectedWidgetIds).toEqual(['a']);
    expect(state().selectedWidgetId).toBe('a');
    act(() => state().selectWidget('b', 'toggle'));

    act(() => state().groupSelection());
    const group = template().groups[0];
    expect(group).toMatchObject({ name: 'Group 1', x: 0.1, y: 0.1 });
    expect(state().selectedGroupId).toBe(group?.id);
    expect(state().selectedWidgetIds).toEqual(['a', 'b']);
    expect(state().dirty).toBe(true);
  });

  it('does not group a single widget', () => {
    threeWidgets();
    act(() => state().selectWidget('a'));
    act(() => state().groupSelection());
    expect(template().groups).toEqual([]);
  });

  it('moves, renames, duplicates, ungroups and removes groups', () => {
    threeWidgets();
    const g = groupAB();
    act(() => state().moveGroupBy(g, 0.1, 0));
    expect(stored('a').x).toBeCloseTo(0.2);
    expect(template().groups[0]?.x).toBeCloseTo(0.2);
    act(() => state().updateGroup(g, { name: 'Timing', visible: false }));
    expect(template().groups[0]).toMatchObject({ name: 'Timing', visible: false });
    act(() => state().moveGroupLayer(g, 1));
    expect(ids()).toEqual(['c', 'a', 'b']);

    act(() => state().duplicateGroup(g));
    expect(template().groups).toHaveLength(2);
    expect(template().widgets).toHaveLength(5);
    const copy = state().selectedGroupId as string;
    act(() => state().removeGroup(copy));
    expect(template().widgets).toHaveLength(3);
    expect(state().selectedGroupId).toBeNull();

    act(() => state().ungroup(g));
    expect(template().groups).toEqual([]);
    expect(state().selectedWidgetIds).toEqual(['a', 'b']);
  });

  it('keeps groups consistent when widgets are removed, duplicated, moved or imported', () => {
    threeWidgets();
    const g = groupAB();
    act(() => state().duplicateWidget('a'));
    // The copy stays in the group, in front of its source.
    expect(template().widgets[1]?.groupId).toBe(g);
    expect(stored('c').groupId).toBeNull();
    act(() => state().moveWidget('b', 1));
    expect(ids().indexOf('b')).toBeLessThan(ids().indexOf('c'));

    act(() => state().removeWidget('a'));
    act(() => state().removeWidget(template().widgets[0]?.id as string));
    act(() => state().removeWidget('b'));
    expect(template().groups).toEqual([]);

    act(() => state().setWidgetGroup('c', null));
    expect(stored('c').groupId).toBeNull();
  });

  it('removes the selection at once', () => {
    threeWidgets();
    act(() => {
      state().selectWidget('a');
      state().selectWidget('c', 'toggle');
      state().removeSelection();
    });
    expect(ids()).toEqual(['b']);
    expect(state().selectedWidgetIds).toEqual([]);
  });

  it('aligns to the group, the selection, the frame or the guides', () => {
    threeWidgets();
    const g = groupAB();
    // The group's box: 0.1 to 0.4 wide.
    act(() => state().alignSelection('right'));
    expect(stored('a').x).toBeCloseTo(0.3);
    expect(stored('b').x).toBeCloseTo(0.3);

    // One widget in a group: to its group.
    act(() => state().selectWidget('a'));
    act(() => state().alignSelection('top'));
    expect(stored('a').y).toBeCloseTo(0.1);

    // One widget on its own: to the frame.
    act(() => state().selectWidget('c'));
    act(() => state().alignSelection('center'));
    expect(stored('c').x).toBeCloseTo(0.45);

    // Several widgets: to their box; three of them can be spread.
    act(() => {
      state().ungroup(g);
      state().selectWidget('c', 'toggle');
      state().alignSelection('bottom');
    });
    expect(stored('a').y + 0.1).toBeCloseTo(0.7);
    act(() => state().distributeSelection('horizontal'));

    act(() => state().setAlignTo('guides'));
    expect(localStorage.getItem('custom-overlay.editor.alignTo')).toBe('guides');
    act(() => {
      state().selectWidget('c');
      state().alignSelection('right');
    });
    // The frame edge is the nearest guide that keeps it inside.
    expect(stored('c').x).toBeCloseTo(0.9);
    act(() => state().selectWidget(null));
    act(() => state().alignSelection('left'));
  });

  it('remembers what to snap to', () => {
    act(() => state().setSnapTo('group'));
    expect(state().snapTo).toBe('group');
    expect(localStorage.getItem('custom-overlay.editor.snapTo')).toBe('group');
  });
});

describe('WidgetList with groups', () => {
  it('lists a group with its members, collapses it, and selects with Ctrl', () => {
    threeWidgets();
    render(<WidgetList />);
    const name = (text: string) => screen.getByRole('button', { name: new RegExp(`^${text}`) });
    fireEvent.click(name('Widget a'));
    fireEvent.click(name('Widget b'), { ctrlKey: true });
    expect(state().selectedWidgetIds).toEqual(['a', 'b']);
    const group = screen.getByRole('button', { name: /Group$/ });
    fireEvent.click(group);
    expect(template().groups).toHaveLength(1);

    const row = name('Group 1').closest('li') as HTMLElement;
    expect(row.className).toContain('group-row');
    expect(row.className).toContain('active');
    expect(name('Widget a').closest('li')?.className).toBe('member');
    fireEvent.click(within(row).getByTitle('Collapse group'));
    expect(screen.queryByRole('button', { name: /^Widget a/ })).toBeNull();
    fireEvent.click(within(row).getByTitle('Expand group'));

    fireEvent.click(within(row).getByTitle('Hide'));
    expect(template().groups[0]?.visible).toBe(false);
    fireEvent.click(within(row).getByTitle('Bring forward'));
    expect(ids()).toEqual(['c', 'a', 'b']);
    fireEvent.click(name('Widget c'));
    expect(state().selectedGroupId).toBeNull();
    fireEvent.click(name('Group 1'));
    expect(state().selectedGroupId).toBe(template().groups[0]?.id);
  });
});

describe('WidgetInspector with groups', () => {
  it('edits a selected group', () => {
    threeWidgets();
    const g = groupAB();
    act(() => state().updateWidget('b', { groupPosition: 'absolute' }));
    render(<WidgetInspector />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Timing' } });
    expect(template().groups[0]?.name).toBe('Timing');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Visible' }));
    expect(template().groups[0]?.visible).toBe(false);
    fireEvent.change(screen.getByLabelText('Origin X %'), { target: { value: '20' } });
    expect(stored('a').x).toBeCloseTo(0.2);
    // Absolute members stay.
    expect(stored('b').x).toBeCloseTo(0.3);
    fireEvent.change(screen.getByLabelText('Origin Y %'), { target: { value: '0' } });
    expect(stored('a').y).toBeCloseTo(0);
    expect(screen.getByText(/1 absolute widget stays put/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Align left edges' }));
    expect(stored('b').x).toBeCloseTo(0.2);
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    expect(template().groups).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Ungroup' }));
    expect(template().groups.map((group) => group.id)).toEqual([g]);
  });

  it('groups or deletes several selected widgets', () => {
    threeWidgets();
    act(() => {
      state().selectWidget('a');
      state().selectWidget('c', 'toggle');
    });
    render(<WidgetInspector />);
    expect(screen.getByText('2 widgets selected')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Distribute horizontally' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Guides' }));
    expect(state().alignTo).toBe('guides');
    expect(screen.getByText(/To the nearest guide line/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(ids()).toEqual(['b']);
  });

  it('puts a widget in a group and shows its position from the group origin', () => {
    threeWidgets();
    const g = groupAB();
    act(() => state().selectWidget('c'));
    render(<WidgetInspector />);
    fireEvent.change(screen.getByLabelText('Group'), { target: { value: g } });
    expect(stored('c').groupId).toBe(g);
    // 0.6 in the frame, the origin at 0.1.
    expect((screen.getByLabelText('X from group %') as HTMLInputElement).value).toBe('50');
    fireEvent.change(screen.getByLabelText('X from group %'), { target: { value: '10' } });
    expect(stored('c').x).toBeCloseTo(0.2);
    fireEvent.click(screen.getByRole('button', { name: 'Absolute' }));
    expect(stored('c').groupPosition).toBe('absolute');
    expect((screen.getByLabelText('X %') as HTMLInputElement).value).toBe('20');
    fireEvent.change(screen.getByLabelText('Group'), { target: { value: '' } });
    expect(stored('c').groupId).toBeNull();
  });

  it('shows background settings only while the background is on', () => {
    setTemplate({ widgets: [createWidget('lap-count', { id: 'l' })] });
    act(() => state().selectWidget('l'));
    render(<WidgetInspector />);
    expect(screen.getByText('Background color')).toBeTruthy();
    expect(screen.getByText('Corner radius')).toBeTruthy();
    const shape = screen
      .getByText('Background shape')
      .parentElement?.querySelector('select') as HTMLSelectElement;
    fireEvent.change(shape, { target: { value: 'pill' } });
    expect(stored('l').props.backgroundShape).toBe('pill');
    expect(screen.queryByText('Corner radius')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Background panel' }));
    expect(screen.queryByText('Background color')).toBeNull();
  });
});

describe('groups on the stage', () => {
  const LAYER = { width: 1000, height: 500 };
  beforeEach(() => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    vi.stubGlobal('Image', FakeImage);
  });
  afterEach(() => vi.unstubAllGlobals());

  function renderEditor() {
    const view = render(
      <div className="stage">
        <OverlayEditor />
      </div>,
    );
    const handles = document.querySelector('.widget-handles') as HTMLElement;
    stubRect(handles, LAYER.width, LAYER.height);
    act(() => FakeResizeObserver.resizeAll(LAYER.width, LAYER.height));
    return { view, handles };
  }

  it('drags a group by its tab, snapping to the other widgets', () => {
    state().setSnapTo('group');
    threeWidgets();
    const g = groupAB();
    const { handles } = renderEditor();
    const tab = screen.getByRole('button', { name: 'Group 1' });
    expect(document.querySelector('.group-origin')).toBeTruthy();
    fireEvent.pointerDown(tab, { clientX: 100, clientY: 50, pointerId: 1 });
    // 0.497 → snaps to c's left edge (0.6) with the group's right edge (0.4 + 0.2).
    fireEvent.pointerMove(handles, { clientX: 297, clientY: 50 });
    expect(stored('b').x + 0.1).toBeCloseTo(0.6);
    expect(template().groups[0]?.x).toBeCloseTo(0.3);
    expect(document.querySelector('.guide.v.active')).toBeTruthy();
    fireEvent.pointerUp(handles);
    expect(state().selectedGroupId).toBe(g);
  });

  it('drags every selected widget, and adds to the selection with Ctrl', () => {
    state().setSnap(false);
    threeWidgets();
    renderEditor();
    const box = (name: string) => screen.getByTitle(name);
    fireEvent.pointerDown(box('Widget a'), { pointerId: 1 });
    fireEvent.pointerUp(document.querySelector('.widget-handles') as HTMLElement);
    fireEvent.pointerDown(box('Widget c'), { pointerId: 1, ctrlKey: true });
    expect(state().selectedWidgetIds).toEqual(['a', 'c']);
    // No resize handle for several widgets.
    expect(document.querySelector('.widget-resize')).toBeNull();
    const handles = document.querySelector('.widget-handles') as HTMLElement;
    fireEvent.pointerDown(box('Widget a'), { clientX: 100, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(handles, { clientX: 200, clientY: 100 });
    expect(stored('a')).toMatchObject({ x: 0.2, y: 0.2 });
    expect(stored('c')).toMatchObject({ x: 0.7, y: 0.7 });
    expect(stored('b')).toMatchObject({ x: 0.3, y: 0.2 });
  });

  it('snaps a group member to the rest of its group only', () => {
    state().setSnapTo('group');
    threeWidgets();
    groupAB();
    const { handles } = renderEditor();
    act(() => state().selectWidget('a'));
    // a's left edge at 0.1 + 0.195: snaps to b's left (0.3), not to c.
    fireEvent.pointerDown(screen.getByTitle('Widget a'), { clientX: 100, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(handles, { clientX: 295, clientY: 50 });
    expect(stored('a').x).toBeCloseTo(0.3);
  });
});

describe('editor keys', () => {
  beforeEach(() => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    vi.stubGlobal('Image', FakeImage);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('groups, ungroups, clears and deletes from the keyboard', () => {
    threeWidgets();
    render(<TemplateStep />);
    act(() => {
      state().selectWidget('a');
      state().selectWidget('b', 'toggle');
    });
    fireEvent.keyDown(window, { key: 'g', ctrlKey: true });
    expect(template().groups).toHaveLength(1);
    fireEvent.keyDown(window, { key: 'G', ctrlKey: true, shiftKey: true });
    expect(template().groups).toHaveLength(0);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(state().selectedWidgetIds).toEqual([]);
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(ids()).toEqual(['a', 'b', 'c']);
    act(() => state().selectWidget('c'));
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(ids()).toEqual(['a', 'b']);
    const g = groupAB();
    // Typing in a field never deletes widgets.
    fireEvent.keyDown(screen.getAllByRole('textbox')[0] as HTMLElement, { key: 'Backspace' });
    expect(template().groups.map((group) => group.id)).toEqual([g]);
    fireEvent.keyDown(window, { key: 'Backspace' });
    expect(ids()).toEqual([]);
    fireEvent.keyDown(window, { key: 'x' });
  });
});
