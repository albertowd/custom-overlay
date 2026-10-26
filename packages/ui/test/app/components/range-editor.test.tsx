import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RangeEditor, type TimeRange } from '../../../src/app/components/RangeEditor';
import { formatTime } from '../../../src/app/format';
import { t } from '../../../src/app/i18n';
import { useStore } from '../../../src/app/store';
import { resetStore } from './form-helpers';

const seek = vi.fn();
const OPEN: TimeRange = { start: null, end: null };

beforeEach(() => {
  seek.mockClear();
  resetStore({ seek });
});

function setup(range: TimeRange = OPEN, props: Partial<Parameters<typeof RangeEditor>[0]> = {}) {
  const onChange = vi.fn<(range: TimeRange) => void>();
  const user = userEvent.setup();
  const result = render(
    <RangeEditor range={range} min={0} max={100} frameRate={10} onChange={onChange} {...props} />,
  );
  return { ...result, user, onChange };
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

/** Lay the trim bar out 200 px wide from x = 0 (jsdom has no layout). */
function layOut(container: HTMLElement, width = 200) {
  const bar = container.querySelector('.trim-bar') as HTMLDivElement;
  bar.getBoundingClientRect = () => ({ left: 0, width }) as DOMRect;
  bar.setPointerCapture = vi.fn();
  return bar;
}

describe('RangeEditor', () => {
  it('follows the timeline when open, with its duration in frames', () => {
    setup();
    expect(field(t('common.start')).value).toBe('');
    expect(screen.getByText(`${formatTime(0)} – ${formatTime(100)}`)).toBeTruthy();
    expect(screen.getByText(`${formatTime(100)} · ${t('track.range.frames', { count: 1000 })}`)).toBeTruthy();
    expect(screen.getAllByText(t('sync.timeInput.followsTimeline'))).toHaveLength(2);
    expect(button(t('track.range.wholeTimeline')).disabled).toBe(true);
  });

  it('types a start and an end inside the timeline', async () => {
    const { user, onChange } = setup({ start: null, end: 50 });
    await user.clear(field(t('common.start')));
    await user.type(field(t('common.start')), '0:10{Enter}');
    expect(onChange).toHaveBeenLastCalledWith({ start: 10, end: 50 });
    await user.clear(field(t('common.end')));
    await user.type(field(t('common.end')), '1:30{Enter}');
    expect(onChange).toHaveBeenLastCalledWith({ start: null, end: 90 });
    await user.clear(field(t('common.end')));
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith({ start: null, end: null });
  });

  it('rejects a start after the end and an end past the timeline', async () => {
    const { user, onChange } = setup({ start: 20, end: 50 });
    await user.clear(field(t('common.start')));
    await user.type(field(t('common.start')), '0:50{Enter}');
    expect(screen.getByText(t('track.range.rejected'))).toBeTruthy();
    await user.clear(field(t('common.end')));
    await user.type(field(t('common.end')), '2:00{Enter}');
    await user.clear(field(t('common.end')));
    await user.type(field(t('common.end')), '0:20{Enter}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('sets the bounds at the playhead, snapped to frames, and seeks to them', async () => {
    useStore.setState({ currentTime: 12.345 });
    const { user, onChange } = setup({ start: 10, end: 40 });
    await user.click(button(t('track.range.startAtPlayhead')));
    expect(onChange.mock.lastCall?.[0].start).toBeCloseTo(12.3);
    await user.click(button(t('track.range.endAtPlayhead')));
    expect(onChange.mock.lastCall?.[0].end).toBeCloseTo(12.3);
    await user.click(button(t('track.range.goToStart')));
    expect(seek).toHaveBeenLastCalledWith(10);
    await user.click(button(t('track.range.goToEnd')));
    expect(seek).toHaveBeenLastCalledWith(40);
  });

  it('selects the whole timeline again', async () => {
    const { user, onChange } = setup({ start: 10, end: null });
    await user.click(button(t('track.range.wholeTimeline')));
    expect(onChange).toHaveBeenCalledWith({ start: null, end: null });
  });

  it('goes back to narrower defaults or to the whole timeline', async () => {
    const defaults = { start: 10, end: 90, label: 'Data range', emptyHint: 'Follows the data' };
    const { user, onChange, rerender } = setup(OPEN, { defaults });
    expect(screen.getAllByText('Follows the data')).toHaveLength(2);
    expect(button('Data range').disabled).toBe(true);
    expect(screen.getByText(`${formatTime(10)} – ${formatTime(90)}`)).toBeTruthy();
    await user.click(button(t('track.range.wholeTimeline')));
    expect(onChange).toHaveBeenCalledWith({ start: 0, end: 100 });

    rerender(
      <RangeEditor
        range={{ start: 0, end: 100 }}
        min={0}
        max={100}
        frameRate={10}
        onChange={onChange}
        defaults={defaults}
      />,
    );
    expect(button(t('track.range.wholeTimeline')).disabled).toBe(true);
    await user.click(button('Data range'));
    expect(onChange).toHaveBeenLastCalledWith({ start: null, end: null });
  });

  it('treats defaults equal to the timeline as the timeline', () => {
    setup(OPEN, { defaults: { start: 0, end: 100, label: 'Data range', emptyHint: 'Follows the data' } });
    expect(screen.queryByRole('button', { name: 'Data range' })).toBeNull();
    expect(screen.queryByText('Follows the data')).toBeNull();
  });

  it('sets the start with I and the end with O at the playhead', () => {
    useStore.setState({ currentTime: 30 });
    const { onChange } = setup({ start: 10, end: 50 });
    fireEvent.keyDown(window, { key: 'i' });
    expect(onChange).toHaveBeenLastCalledWith({ start: 30, end: 50 });
    fireEvent.keyDown(window, { key: 'O' });
    expect(onChange).toHaveBeenLastCalledWith({ start: 10, end: 30 });
    fireEvent.keyDown(window, { key: 'I' });
    fireEvent.keyDown(window, { key: 'o' });
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it('ignores shortcuts while typing, with modifiers or when disabled', () => {
    const { onChange, unmount } = setup();
    fireEvent.keyDown(field(t('common.start')), { key: 'i' });
    fireEvent.keyDown(window, { key: 'i', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'o', metaKey: true });
    fireEvent.keyDown(window, { key: 'o', altKey: true });
    fireEvent.keyDown(window, { key: 'x' });
    expect(onChange).not.toHaveBeenCalled();
    unmount();
    setup(OPEN, { shortcuts: false });
    fireEvent.keyDown(window, { key: 'i' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('drags the start and end handles, kept a frame apart', () => {
    const { container, onChange } = setup({ start: 10, end: 50 });
    const bar = layOut(container);
    const [startHandle, endHandle] = container.querySelectorAll('[data-handle]') as unknown as HTMLElement[];
    expect((startHandle as HTMLElement).style.left).toBe('10%');
    fireEvent.pointerDown(startHandle as HTMLElement, { clientX: 50, pointerId: 1 });
    expect(bar.setPointerCapture).toHaveBeenCalledWith(1);
    expect(onChange).toHaveBeenLastCalledWith({ start: 25, end: 50 });
    fireEvent.pointerMove(bar, { clientX: 150 });
    expect(onChange.mock.lastCall?.[0].start).toBeCloseTo(49.9);
    fireEvent.pointerUp(bar);
    onChange.mockClear();
    fireEvent.pointerMove(bar, { clientX: 20 });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.pointerDown(endHandle as HTMLElement, { clientX: 300, pointerId: 2 });
    expect(onChange).toHaveBeenLastCalledWith({ start: 10, end: 100 });
    fireEvent.pointerMove(bar, { clientX: 0 });
    expect(onChange.mock.lastCall?.[0].end).toBeCloseTo(10.1);
    expect(seek).not.toHaveBeenCalled();
  });

  it('seeks where the bar is clicked', () => {
    const { container, onChange } = setup();
    const bar = layOut(container);
    fireEvent.pointerDown(container.querySelector('.trim-playhead') as HTMLElement, {
      clientX: 100,
      pointerId: 1,
    });
    expect(seek).toHaveBeenLastCalledWith(50);
    fireEvent.pointerMove(bar, { clientX: -40 });
    expect(seek).toHaveBeenLastCalledWith(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('seeks to the start of a bar without layout', () => {
    const { container } = setup();
    layOut(container, 0);
    fireEvent.pointerDown(container.querySelector('.trim-bar') as HTMLElement, {
      clientX: 100,
      pointerId: 1,
    });
    expect(seek).toHaveBeenLastCalledWith(0);
  });

  it('defaults to 30 fps without a frame rate', () => {
    setup(OPEN, { frameRate: 0 });
    expect(screen.getByText(`${formatTime(100)} · ${t('track.range.frames', { count: 0 })}`)).toBeTruthy();
  });
});
