import { createWidget, type Widget } from '@custom-overlay/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { WidgetInspector, WidgetList } from '../../../src/app/components/WidgetsPanel';
import { useStore } from '../../../src/app/store';
import { api } from '../fake-api';
import { loadVideoProject, resetStore, valuesSnapshot } from './canvas-helpers';

function setWidgets(widgets: Widget[]): void {
  const { project } = useStore.getState();
  useStore.setState({ project: { ...project, template: { ...project.template, widgets } } });
}

const widgets = () => useStore.getState().project.template.widgets;
const stored = (id: string) => widgets().find((w) => w.id === id) as Widget;
const select = (id: string | null) => act(() => useStore.getState().selectWidget(id));

describe('WidgetList', () => {
  beforeEach(resetStore);

  it('invites to add a widget and forces sample data without project values', () => {
    render(<WidgetList />);
    expect(screen.getByText(/No widgets yet/)).toBeTruthy();
    const sample = screen.getByRole('checkbox', { name: 'Sample data' }) as HTMLInputElement;
    expect(sample.checked).toBe(true);
    expect(sample.disabled).toBe(true);
  });

  it('switches the sample data on and off when there are values', () => {
    useStore.setState({ values: valuesSnapshot({ 'speed.kmh': () => 1 }) });
    render(<WidgetList />);
    const sample = screen.getByRole('checkbox', { name: 'Sample data' }) as HTMLInputElement;
    expect(sample.checked).toBe(false);
    fireEvent.click(sample);
    expect(useStore.getState().sampleData).toBe(true);
  });

  it('lists the widgets front first with their type and own ranges, and selects one', () => {
    setWidgets([
      createWidget('text', { id: 'back', name: 'Title' }),
      createWidget('speed-gauge', { id: 'front', name: '', visibleRange: { start: 1, end: 2 } }),
      createWidget('text', { id: 'odd', name: 'Odd', type: 'no-such-type' }),
    ]);
    render(<WidgetList />);
    const names = screen.getAllByRole('button', { name: /Title|speed-gauge|Odd/ }).map((b) => b.textContent);
    expect(names[0]).toBe('Oddno-such-type');
    expect(names[1]).toBe('speed-gaugeSpeed gauge · own time range');
    expect(names[2]).toBe('TitleText');
    fireEvent.click(screen.getByRole('button', { name: /^Title/ }));
    expect(useStore.getState().selectedWidgetId).toBe('back');
    expect(screen.getByRole('button', { name: /^Title/ }).closest('li')?.className).toBe('active');
  });

  it('hides, shows and reorders widgets', () => {
    setWidgets([
      createWidget('text', { id: 'a', name: 'A' }),
      createWidget('text', {
        id: 'b',
        name: 'B',
        dataRange: { start: { kind: 'time', time: 3 }, end: null },
      }),
    ]);
    render(<WidgetList />);
    expect(screen.getByText(/own data range/)).toBeTruthy();
    const rowOf = (name: string) =>
      within(screen.getByRole('button', { name: new RegExp(`^${name}Text`) }).closest('li') as HTMLElement);
    fireEvent.click(rowOf('A').getByTitle('Hide'));
    expect(stored('a').visible).toBe(false);
    fireEvent.click(rowOf('A').getByTitle('Show'));
    expect(stored('a').visible).toBe(true);
    fireEvent.click(rowOf('A').getByTitle('Bring forward'));
    expect(widgets().map((w) => w.id)).toEqual(['b', 'a']);
    fireEvent.click(rowOf('A').getByTitle('Send backward'));
    expect(widgets().map((w) => w.id)).toEqual(['a', 'b']);
  });
});

describe('WidgetInspector', () => {
  beforeEach(resetStore);

  it('asks to select a widget, with export disabled', () => {
    render(<WidgetInspector />);
    expect(screen.getByText(/Select a widget/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Export…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('adds a widget picked by type, or cancels the picker', () => {
    render(<WidgetInspector />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add widget' }));
    for (const category of ['Data', 'Maps', 'Text', 'Images']) {
      expect(screen.getByRole('heading', { name: category })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'Maps' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '+ Add widget' }));
    fireEvent.click(screen.getByRole('button', { name: /^Speed gauge/ }));
    expect(widgets()).toHaveLength(1);
    expect(widgets()[0]?.type).toBe('speed-gauge');
    expect(useStore.getState().selectedWidgetId).toBe(widgets()[0]?.id);
    expect(screen.getByRole('heading', { name: 'Speed gauge' })).toBeTruthy();
  });

  it('closes the picker when another widget gets selected', () => {
    setWidgets([createWidget('text', { id: 'a' })]);
    render(<WidgetInspector />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add widget' }));
    expect(screen.getByRole('heading', { name: 'Maps' })).toBeTruthy();
    select('a');
    expect(screen.queryByRole('heading', { name: 'Maps' })).toBeNull();
    expect(screen.getByRole('button', { name: '+ Add widget' })).toBeTruthy();
  });

  it('imports widgets and exports the selected one', async () => {
    const imported = createWidget('text', { id: 'from-file', name: 'Imported' });
    api().openWidgets.mockResolvedValue([imported]);
    setWidgets([createWidget('text', { id: 'a', name: 'Mine' })]);
    select('a');
    render(<WidgetInspector />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Import…' })));
    expect(widgets().map((w) => w.name)).toEqual(['Mine', 'Imported']);
    select('a');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Export…' })));
    expect(api().saveWidget).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', name: 'Mine' }));
  });

  it('reports a widget of an unknown type', () => {
    setWidgets([createWidget('text', { id: 'a', type: 'gone' })]);
    select('a');
    render(<WidgetInspector />);
    expect(screen.getByText("Unknown widget type 'gone'")).toBeTruthy();
  });

  describe('inspector', () => {
    beforeEach(() => {
      setWidgets([createWidget('text', { id: 'a', name: 'Title', x: 0.1, y: 0.2, width: 0.3, height: 0.1 })]);
      select('a');
    });

    it('renames, duplicates and deletes', () => {
      render(<WidgetInspector />);
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Driver' } });
      expect(stored('a').name).toBe('Driver');
      fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
      expect(widgets()).toHaveLength(2);
      expect(widgets()[1]?.name).toBe('Driver');
      expect(widgets()[1]?.x).toBeCloseTo(0.12);
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
      expect(widgets()).toHaveLength(1);
      expect(screen.getByText(/Select a widget/)).toBeTruthy();
    });

    it('places the widget by its anchor in percent of the frame', () => {
      render(<WidgetInspector />);
      fireEvent.click(screen.getByTitle('Anchor: center'));
      expect(stored('a').anchor).toBe('center');
      expect(screen.getByTitle('Anchor: center').getAttribute('aria-pressed')).toBe('true');
      // X / Y are the anchor point: the centre of the box.
      expect((screen.getByLabelText('X %') as HTMLInputElement).value).toBe('25');
      fireEvent.change(screen.getByLabelText('X %'), { target: { value: '50' } });
      expect(stored('a').x).toBeCloseTo(0.35);
      fireEvent.change(screen.getByLabelText('Y %'), { target: { value: '50' } });
      expect(stored('a').y).toBeCloseTo(0.45);
      fireEvent.change(screen.getByLabelText('Width %'), { target: { value: '50' } });
      expect(stored('a')).toMatchObject({ width: 0.5 });
      expect(stored('a').x).toBeCloseTo(0.25);
      fireEvent.change(screen.getByLabelText('Height %'), { target: { value: '0' } });
      expect(stored('a').height).toBe(0.001);
      fireEvent.change(screen.getByLabelText('Height %'), { target: { value: '' } });
      expect(stored('a').height).toBe(0.001);
    });

    it('sets opacity and anti-aliasing', () => {
      render(<WidgetInspector />);
      fireEvent.change(screen.getByLabelText('Opacity'), { target: { value: '0.5' } });
      expect(stored('a').opacity).toBe(0.5);
      const antialias = screen.getByLabelText('Anti-aliasing');
      fireEvent.change(antialias, { target: { value: 'false' } });
      expect(stored('a').antialias).toBe(false);
      fireEvent.change(antialias, { target: { value: 'true' } });
      expect(stored('a').antialias).toBe(true);
      fireEvent.change(antialias, { target: { value: 'template' } });
      expect(stored('a').antialias).toBeNull();
    });

    it('shows the widget only while a value holds', () => {
      render(<WidgetInspector />);
      const condition = screen.getByLabelText('Condition') as HTMLSelectElement;
      expect(condition.disabled).toBe(true);
      fireEvent.change(condition, { target: { value: 'zero' } });
      expect(stored('a').showWhen).toBeNull();
      fireEvent.change(screen.getByLabelText('Show when value'), { target: { value: ' speed.kmh ' } });
      expect(stored('a').showWhen).toEqual({ valueId: 'speed.kmh', condition: 'has-value' });
      fireEvent.change(condition, { target: { value: 'positive' } });
      expect(stored('a').showWhen).toEqual({ valueId: 'speed.kmh', condition: 'positive' });
      fireEvent.change(screen.getByLabelText('Show when value'), { target: { value: 'lap.number' } });
      expect(stored('a').showWhen).toEqual({ valueId: 'lap.number', condition: 'positive' });
      fireEvent.change(screen.getByLabelText('Show when value'), { target: { value: '' } });
      expect(stored('a').showWhen).toBeNull();
    });

    it('edits the type settings', () => {
      render(<WidgetInspector />);
      fireEvent.change(document.querySelector('textarea') as HTMLTextAreaElement, {
        target: { value: 'Race 1' },
      });
      expect(stored('a').props.text).toBe('Race 1');
    });

    it('gives the widget its own time range, inside the timeline', () => {
      loadVideoProject();
      setWidgets([createWidget('text', { id: 'a', name: 'Title' })]);
      select('a');
      useStore.setState({ currentTime: 2 });
      render(<WidgetInspector />);
      const visible = screen.getByLabelText('Visible') as HTMLSelectElement;
      expect(visible.selectedOptions[0]?.textContent).toBe('Like the template (the whole video)');
      fireEvent.change(visible, { target: { value: 'own' } });
      expect(stored('a').visibleRange).toEqual({ start: null, end: null });
      fireEvent.click(screen.getByRole('button', { name: 'Start at playhead' }));
      expect(stored('a').visibleRange).toEqual({ start: 2, end: null });
      fireEvent.change(visible, { target: { value: 'template' } });
      expect(stored('a').visibleRange).toBeNull();
    });

    it('describes the template time range', () => {
      const { project } = useStore.getState();
      useStore.setState({
        project: { ...project, template: { ...project.template, visibleRange: { start: 5, end: null } } },
      });
      const { rerender } = render(<WidgetInspector />);
      expect((screen.getByLabelText('Visible') as HTMLSelectElement).selectedOptions[0]?.textContent).toBe(
        'Like the template (0:05.000 – end)',
      );
      act(() => {
        const current = useStore.getState().project;
        useStore.setState({
          project: { ...current, template: { ...current.template, visibleRange: { start: null, end: 8 } } },
        });
      });
      rerender(<WidgetInspector />);
      expect((screen.getByLabelText('Visible') as HTMLSelectElement).selectedOptions[0]?.textContent).toBe(
        'Like the template (start – 0:08.000)',
      );
    });

    it('gives the widget its own data range and describes the project one', () => {
      render(<WidgetInspector />);
      const data = screen.getByLabelText('Data') as HTMLSelectElement;
      expect(data.selectedOptions[0]?.textContent).toBe('Like the project (Data from the whole session)');
      fireEvent.change(data, { target: { value: 'own' } });
      expect(stored('a').dataRange).toEqual({ start: null, end: null });
      fireEvent.change(screen.getAllByLabelText('Start').find((e) => e.tagName === 'SELECT') as HTMLElement, {
        target: { value: 'time' },
      });
      expect(stored('a').dataRange?.start).toMatchObject({ kind: 'time' });
      fireEvent.change(data, { target: { value: 'project' } });
      expect(stored('a').dataRange).toBeNull();

      act(() =>
        useStore.setState({
          values: valuesSnapshot({}, 10, { dataRange: { start: 3, end: Number.POSITIVE_INFINITY } }),
        }),
      );
      expect(data.selectedOptions[0]?.textContent).toBe('Like the project (Data from 0:03.000 to the end)');
      act(() =>
        useStore.setState({
          values: valuesSnapshot({}, 10, { dataRange: { start: Number.NEGATIVE_INFINITY, end: 9 } }),
        }),
      );
      expect(data.selectedOptions[0]?.textContent).toBe('Like the project (Data from the start to 0:09.000)');
    });
  });

  it('picks the lap timing of widgets that read lap times', () => {
    setWidgets([createWidget('lap-timer', { id: 't' })]);
    select('t');
    render(<WidgetInspector />);
    const timing = screen.getByLabelText('Lap timing');
    fireEvent.change(timing, { target: { value: 'lines' } });
    expect(stored('t').timing).toBe('lines');
    fireEvent.change(timing, { target: { value: 'project' } });
    expect(stored('t').timing).toBeNull();
  });

  it('has no lap timing choice for other widgets', () => {
    setWidgets([createWidget('text', { id: 'a' })]);
    select('a');
    render(<WidgetInspector />);
    expect(screen.queryByLabelText('Lap timing')).toBeNull();
    expect(screen.queryByText('Test values')).toBeNull();
  });

  it('sets test values for what the widget reads, showing the current values', () => {
    useStore.setState({ values: valuesSnapshot({ 'speed.kmh': () => 42 }), currentTime: 1 });
    setWidgets([createWidget('value-text', { id: 'v', props: { template: '{speed.kmh|0} {rpm}' } })]);
    select('v');
    render(<WidgetInspector />);
    expect(screen.getByText('Test values')).toBeTruthy();
    expect(document.querySelectorAll('datalist option')).toHaveLength(1);
    const speed = screen.getByLabelText('speed.kmh') as HTMLInputElement;
    const rpm = screen.getByLabelText('rpm') as HTMLInputElement;
    expect(speed.placeholder).toContain('42');
    expect(rpm.placeholder).toBe('no such value');
    fireEvent.change(speed, { target: { value: '120' } });
    expect(useStore.getState().testValues).toEqual({ 'speed.kmh': 120 });
    expect(speed.value).toBe('120');
    fireEvent.change(speed, { target: { value: '' } });
    expect(useStore.getState().testValues).toEqual({});
  });

  it('lists test values without project values', () => {
    setWidgets([createWidget('value-text', { id: 'v' })]);
    select('v');
    render(<WidgetInspector />);
    expect((screen.getByLabelText('speed.kmh') as HTMLInputElement).placeholder).toBe('no such value');
  });
});
