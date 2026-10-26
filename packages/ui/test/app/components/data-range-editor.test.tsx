import type { DataRange } from '@custom-overlay/core';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataRangeEditor } from '../../../src/app/components/DataRangeEditor';
import { formatTime } from '../../../src/app/format';
import { t } from '../../../src/app/i18n';
import { useStore } from '../../../src/app/store';
import { lapTimes, resetStore, snapshot } from './form-helpers';

const WHOLE: DataRange = { start: null, end: null };

/** Laps: 1 at 0 s (30 s), 2 at 30 s (32 s), 3 at 62 s (unfinished). */
function withLaps() {
  useStore.setState({ values: snapshot({ full: lapTimes([30, 32]) }) });
}

function setup(value: DataRange) {
  const onChange = vi.fn<(range: DataRange) => void>();
  const user = userEvent.setup();
  const { unmount } = render(<DataRangeEditor value={value} onChange={onChange} />);
  const [start, end] = screen.getAllByRole('combobox') as [HTMLSelectElement, HTMLSelectElement];
  return { user, onChange, start, end, unmount };
}

/** The first muted paragraph: the resulting times and kept laps. */
const summary = () => document.querySelector('.data-range > p.muted')?.textContent;
const lastRange = (onChange: ReturnType<typeof setup>['onChange']) => onChange.mock.lastCall?.[0];

beforeEach(() => resetStore());

describe('DataRangeEditor', () => {
  it('without laps: only the whole session or times', async () => {
    const { user, onChange, start, end } = setup(WHOLE);
    expect(screen.getByText(t('track.dataRange.noLaps'))).toBeTruthy();
    expect(summary()).toBe(t('track.dataRange.untrimmed'));
    const disabled = screen.getAllByRole('option').filter((o) => (o as HTMLOptionElement).disabled);
    expect(disabled.map((o) => o.textContent)).toEqual([
      t('track.dataRange.lapStart'),
      t('track.dataRange.lapEnd'),
      t('track.dataRange.leaveOut'),
    ]);
    await user.selectOptions(start, 'time');
    expect(lastRange(onChange)).toEqual({ start: { kind: 'time', time: 0 }, end: null });
    await user.selectOptions(end, 'time');
    expect(lastRange(onChange)).toEqual({ start: null, end: { kind: 'time', time: 0 } });
  });

  it('chooses the start bound from the laps', async () => {
    withLaps();
    const { user, onChange, start } = setup(WHOLE);
    expect(summary()).toBe(
      `${t('track.dataRange.untrimmed')} · ${t('track.dataRange.keptLaps', { count: 2, total: 3 })}`,
    );
    await user.selectOptions(start, 'time');
    expect(lastRange(onChange)?.start).toEqual({ kind: 'time', time: 30 });
    await user.selectOptions(start, 'lap');
    expect(lastRange(onChange)?.start).toEqual({ kind: 'lap', lap: 2, fromEnd: false });
  });

  it('chooses the end bound from the laps', async () => {
    withLaps();
    const { user, onChange, end } = setup({ start: { kind: 'time', time: 5 }, end: null });
    await user.selectOptions(end, 'time');
    expect(lastRange(onChange)).toEqual({
      start: { kind: 'time', time: 5 },
      end: { kind: 'time', time: 62 },
    });
    await user.selectOptions(end, 'lap');
    expect(lastRange(onChange)?.end).toEqual({ kind: 'lap', lap: 2, fromEnd: false });
    await user.selectOptions(end, 'leaveOut');
    expect(lastRange(onChange)?.end).toEqual({ kind: 'lap', lap: 2, fromEnd: true });
  });

  it('goes back to the whole session', async () => {
    withLaps();
    const { user, onChange, start, end } = setup({
      start: { kind: 'lap', lap: 2, fromEnd: false },
      end: { kind: 'lap', lap: 2, fromEnd: true },
    });
    expect(start.value).toBe('lap');
    expect(end.value).toBe('leaveOut');
    await user.selectOptions(start, 'whole');
    expect(lastRange(onChange)?.start).toBeNull();
    await user.selectOptions(end, 'whole');
    expect(lastRange(onChange)?.end).toBeNull();
  });

  it('edits time bounds and summarises the kept part', async () => {
    withLaps();
    const range: DataRange = { start: { kind: 'time', time: 30 }, end: { kind: 'time', time: 62 } };
    const { user, onChange } = setup(range);
    expect(summary()).toBe(
      `${t('track.dataRange.summary', { start: formatTime(30), end: formatTime(62) })} · ${t('track.dataRange.keptLaps', { count: 1, total: 3 })}`,
    );
    const [startTime, endTime] = screen.getAllByLabelText(t('track.dataRange.time')) as HTMLInputElement[];
    await user.clear(startTime as HTMLInputElement);
    await user.type(startTime as HTMLInputElement, '0:10{Enter}');
    expect(lastRange(onChange)).toEqual({ ...range, start: { kind: 'time', time: 10 } });
    await user.clear(endTime as HTMLInputElement);
    await user.type(endTime as HTMLInputElement, '1:00{Enter}');
    expect(lastRange(onChange)).toEqual({ ...range, end: { kind: 'time', time: 60 } });
  });

  it('names the open side of a half-trimmed range', () => {
    const { unmount } = setup({ start: { kind: 'time', time: 30 }, end: null });
    expect(summary()).toBe(
      t('track.dataRange.summary', { start: formatTime(30), end: t('track.dataRange.sessionEnd') }),
    );
    unmount();
    setup({ start: null, end: { kind: 'time', time: 30 } });
    expect(summary()).toBe(
      t('track.dataRange.summary', { start: t('track.dataRange.sessionStart'), end: formatTime(30) }),
    );
  });

  it('edits lap numbers, ignoring laps below 1', () => {
    withLaps();
    const range: DataRange = {
      start: { kind: 'lap', lap: 2, fromEnd: false },
      end: { kind: 'lap', lap: 2, fromEnd: false },
    };
    const { onChange } = setup(range);
    const [startLap, endLap] = screen.getAllByLabelText(t('track.dataRange.lap')) as HTMLInputElement[];
    expect((startLap as HTMLInputElement).min).toBe('1');
    fireEvent.change(startLap as HTMLInputElement, { target: { value: '1' } });
    expect(lastRange(onChange)?.start).toEqual({ kind: 'lap', lap: 1, fromEnd: false });
    fireEvent.change(endLap as HTMLInputElement, { target: { value: '3' } });
    expect(lastRange(onChange)?.end).toEqual({ kind: 'lap', lap: 3, fromEnd: false });
    onChange.mockClear();
    fireEvent.change(endLap as HTMLInputElement, { target: { value: '0' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('counts left-out laps from the end', () => {
    withLaps();
    const { onChange } = setup({ start: null, end: { kind: 'lap', lap: 2, fromEnd: true } });
    const left = screen.getByLabelText(t('track.dataRange.lapsLeftOut')) as HTMLInputElement;
    expect(left.value).toBe('1');
    expect(left.min).toBe('0');
    fireEvent.change(left, { target: { value: '0' } });
    expect(lastRange(onChange)?.end).toEqual({ kind: 'lap', lap: 1, fromEnd: true });
    // Leaving out one lap keeps lap 1 (lap 2 is the last completed one).
    expect(summary()).toContain(formatTime(30));
  });

  it('reports lap bounds that do not exist and empty ranges', () => {
    withLaps();
    const { unmount } = setup({
      start: { kind: 'lap', lap: 9, fromEnd: false },
      end: { kind: 'lap', lap: 5, fromEnd: true },
    });
    expect(screen.getByText(t('track.dataRange.problems.lapMissing', { lap: 9 }))).toBeTruthy();
    expect(screen.getByText(t('track.dataRange.problems.notEnoughLaps', { count: 4 }))).toBeTruthy();
    unmount();
    setup({ start: { kind: 'time', time: 50 }, end: { kind: 'time', time: 10 } });
    expect(screen.getByText(t('track.dataRange.problems.empty'))).toBeTruthy();
  });
});
