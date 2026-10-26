import { createTemplate, createWidget } from '@custom-overlay/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { TemplateStep } from '../../../src/app/steps/TemplateStep';
import { useStore } from '../../../src/app/store';
import { api, resetStore, withVideo } from './helpers';

beforeEach(() => {
  resetStore();
  const { project, video, info } = withVideo();
  useStore.setState({ project, videos: { [video.id]: info }, currentTime: 10 });
  api().evaluateValues.mockReturnValue(new Promise(() => undefined));
});

const state = () => useStore.getState();
const remoteError = (message: string) => new Error(`Error invoking remote method 'x': Error: ${message}`);

async function openStyle() {
  await userEvent.click(screen.getByRole('button', { name: 'Style' }));
}

describe('TemplateStep', () => {
  it('loads a template file', async () => {
    api().openTemplate.mockResolvedValue({
      path: '/templates/race.json',
      template: createTemplate({ name: 'Race' }),
    });
    render(<TemplateStep />);
    await userEvent.click(screen.getByRole('button', { name: 'Load template…' }));
    expect(state().project.template.name).toBe('Race');
    expect(state().project.templatePath).toBe('/templates/race.json');
  });

  it('keeps the template when loading is cancelled or fails', async () => {
    render(<TemplateStep />);
    const before = state().project.template;
    await userEvent.click(screen.getByRole('button', { name: 'Load template…' }));
    expect(state().project.template).toBe(before);

    api().openTemplate.mockRejectedValue(remoteError('not a template'));
    await userEvent.click(screen.getByRole('button', { name: 'Load template…' }));
    expect(state().notice).toEqual({ kind: 'error', message: 'Could not load the template: not a template' });
  });

  it('saves the template and links the project to the file', async () => {
    render(<TemplateStep />);
    await userEvent.click(screen.getByRole('button', { name: 'Save template as…' }));
    expect(state().project.templatePath).toBeNull();

    api().saveTemplate.mockResolvedValue('/templates/mine.json');
    await userEvent.click(screen.getByRole('button', { name: 'Save template as…' }));
    expect(api().saveTemplate).toHaveBeenLastCalledWith(state().project.template);
    expect(state().project.templatePath).toBe('/templates/mine.json');

    api().saveTemplate.mockRejectedValue(remoteError('disk full'));
    await userEvent.click(screen.getByRole('button', { name: 'Save template as…' }));
    expect(state().notice?.message).toBe('Could not save the template: disk full');
  });

  it('toggles snapping and guides', async () => {
    render(<TemplateStep />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Snap to guides' }));
    expect(state().snap).toBe(false);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show guides' }));
    expect(state().showGuides).toBe(false);
  });

  it('sets the visible range of the widgets', async () => {
    render(<TemplateStep />);
    await userEvent.click(screen.getByRole('button', { name: 'Start at playhead' }));
    // On a frame of the output (59.94 fps).
    expect(state().project.template.visibleRange.start).toBeCloseTo(10, 1);
  });

  it('switches tabs and opens the widget settings when a widget is selected', async () => {
    render(<TemplateStep />);
    await userEvent.click(screen.getByRole('button', { name: 'Values' }));
    expect(screen.getByRole('button', { name: 'Values' }).className).toBe('active');
    await openStyle();
    expect(screen.getByLabelText('Template name')).toBeTruthy();

    const widget = createWidget('text');
    act(() => {
      state().setTemplate({ ...state().project.template, widgets: [widget] });
      state().selectWidget(widget.id);
    });
    expect(screen.getByRole('button', { name: 'Widget' }).className).toBe('active');
    expect(screen.queryByLabelText('Template name')).toBeNull();
  });

  it('edits the template style', async () => {
    useStore.setState({ project: { ...state().project, templatePath: '/templates/race.json' } });
    render(<TemplateStep />);
    await openStyle();
    expect(screen.getByText('Linked file: /templates/race.json')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Night race' } });
    expect(state().project.template.name).toBe('Night race');
    fireEvent.change(screen.getByLabelText(/Font family/), { target: { value: 'Inter, sans-serif' } });
    expect(state().project.template.font).toBe('Inter, sans-serif');
    const antialias = state().project.template.antialias;
    await userEvent.click(screen.getByRole('checkbox', { name: /Anti-alias widget edges/ }));
    expect(state().project.template.antialias).toBe(!antialias);
  });

  it('edits palette colors from the picker and as hex text', async () => {
    render(<TemplateStep />);
    await openStyle();
    const alpha = state().project.palette.background.slice(7);

    fireEvent.change(screen.getByLabelText('Panel background color'), { target: { value: '#102030' } });
    expect(state().project.palette.background).toBe(`#102030${alpha}`);

    const hex = screen.getByLabelText('Primary hex value') as HTMLInputElement;
    fireEvent.change(hex, { target: { value: '#abcdef' } });
    expect(state().project.palette.primary).toBe('#abcdef');
    fireEvent.change(hex, { target: { value: '#12' } });
    expect(hex.value).toBe('#12');
    expect(state().project.palette.primary).toBe('#abcdef');
    fireEvent.blur(hex);
    expect(hex.value).toBe('#abcdef');
  });

  it('edits the guides', async () => {
    render(<TemplateStep />);
    await openStyle();
    const guides = () => state().project.template.guides;

    fireEvent.change(screen.getByLabelText('Columns'), { target: { value: '30' } });
    expect(guides().columns).toBe(24);
    fireEvent.change(screen.getByLabelText('Rows'), { target: { value: '' } });
    expect(guides().rows).toBe(0);
    fireEvent.change(screen.getByLabelText('Safe margin %'), { target: { value: '60' } });
    expect(guides().margin).toBe(49);
    fireEvent.change(screen.getByLabelText('Safe margin %'), { target: { value: '' } });
    expect(guides().margin).toBe(0);

    const vertical = screen.getByLabelText('Extra vertical lines %');
    await userEvent.type(vertical, '25, 75; 200 x');
    expect(guides().vertical).toEqual([]);
    fireEvent.blur(vertical);
    expect(guides().vertical).toEqual([25, 75]);
    expect((vertical as HTMLInputElement).value).toBe('25, 75');
    // Leaving the field untouched keeps the lines.
    fireEvent.blur(vertical);
    expect(guides().vertical).toEqual([25, 75]);

    await userEvent.type(screen.getByLabelText('Extra horizontal lines %'), '50{Enter}');
    expect(guides().horizontal).toEqual([50]);

    await userEvent.click(screen.getByRole('button', { name: 'Center lines' }));
    expect(guides()).toMatchObject({ columns: 2, rows: 2 });
    await userEvent.click(screen.getByRole('button', { name: 'Thirds' }));
    expect(guides()).toMatchObject({ columns: 3, rows: 3 });
    await userEvent.click(screen.getByRole('button', { name: '5% safe area' }));
    expect(guides().margin).toBe(5);
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(guides()).toMatchObject({ columns: 0, rows: 0, margin: 0, vertical: [], horizontal: [] });
  });

  it('sets the canvas shape and how the video fits in it', () => {
    render(<TemplateStep />);
    const output = () => state().project.output;
    const format = screen.getByLabelText('Format') as HTMLSelectElement;
    expect(format.value).toBe('landscape');
    fireEvent.change(format, { target: { value: 'vertical' } });
    // The short side of the 4K video is kept.
    expect(output()).toMatchObject({ width: 2160, height: 3840 });
    expect(format.value).toBe('vertical');
    fireEvent.change(format, { target: { value: 'video' } });
    expect(output()).toMatchObject({ width: 3840, height: 2160 });
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '2560' } });
    expect(format.value).toBe('custom');
    expect(screen.getByRole('option', { name: 'Custom (2560 × 2160)' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Height'), { target: { value: '8' } });
    expect(output().height).toBe(2160);

    fireEvent.change(screen.getByLabelText('Video placement'), { target: { value: 'blur' } });
    expect(output().fit.mode).toBe('blur');
    expect(screen.getByText(/over a blurred copy filling the canvas/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Zoom'), { target: { value: '1.5' } });
    fireEvent.change(screen.getByLabelText('Zoom'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText(/Horizontal position/), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText(/Vertical position/), { target: { value: '25' } });
    expect(output().fit).toEqual({
      mode: 'blur',
      rotation: 0,
      rotateWidgets: false,
      zoom: 1.5,
      x: 0,
      y: 0.25,
    });

    fireEvent.change(screen.getByLabelText('Rotation'), { target: { value: '270' } });
    expect(output().fit.rotation).toBe(270);
    expect(screen.getByText(/turned first and then fitted/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Rotation'), { target: { value: '45' } });
    expect(output().fit.rotation).toBe(270);
    expect(screen.getByText(/The widgets stay upright/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Turn the widgets with the video'));
    expect(output().fit.rotateWidgets).toBe(true);
    expect(screen.getByText(/a landscape template works unchanged/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Rotation'), { target: { value: '0' } });
    expect(screen.queryByLabelText('Turn the widgets with the video')).toBeNull();
  });

  it('only sizes the canvas without a video', () => {
    resetStore();
    render(<TemplateStep />);
    expect(screen.getByText(/Without a video only the canvas size matters/)).toBeTruthy();
    expect(screen.queryByLabelText('Video placement')).toBeNull();
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'square' } });
    expect(state().project.output).toMatchObject({ width: 1080, height: 1080 });
  });
});
