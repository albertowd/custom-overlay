import type { ValueInfo, ValueOrigin } from '@custom-overlay/core';
import { useLanguage } from '../../../src/app/i18n';
import { type Store, useStore } from '../../../src/app/store';
import type { ValuesSnapshot } from '../../../src/shared/api';

const initialStore = useStore.getState();
const initialLanguage = useLanguage.getState();

/** Back to a fresh store (and English), with `patch` applied: actions can be replaced by vi.fn. */
export function resetStore(patch: Partial<Store> = {}): void {
  useStore.setState({ ...initialStore, ...patch }, true);
  useLanguage.setState(initialLanguage, true);
}

export function valueInfo(
  id: string,
  origin: ValueOrigin = 'builtin',
  patch: Partial<ValueInfo> = {},
): ValueInfo {
  return { id, name: id, description: '', unit: '', initial: null, origin, ...patch };
}

/**
 * A values snapshot on a 10 fps grid starting at 0. `data` gives every frame of each value, `full`
 * the whole-session values (laps) when they differ.
 */
export function snapshot({
  values = [],
  data = {},
  full = data,
  errors = {},
  frameRate = 10,
}: {
  values?: ValueInfo[];
  data?: Record<string, number[]>;
  full?: Record<string, number[]>;
  errors?: Record<string, string>;
  frameRate?: number;
}): ValuesSnapshot {
  const arrays = (record: Record<string, number[]>) =>
    Object.fromEntries(Object.entries(record).map(([id, list]) => [id, Float64Array.from(list)]));
  const count = Math.max(
    0,
    ...Object.values(full).map((list) => list.length),
    ...Object.values(data).map((l) => l.length),
  );
  return {
    grid: { start: 0, frameRate, count },
    values,
    data: arrays(data),
    errors,
    full: arrays(full),
    ranges: {},
    dataRange: null,
    dataRangeProblems: [],
  };
}

/**
 * Per frame lap time (10 fps) of laps of the given durations, the last one unfinished: lap 1
 * starts at 0, lap N at the sum of the previous durations.
 */
export function lapTimes(
  durations: number[],
  unfinished = 2,
): { 'lap.time': number[]; 'lap.number': number[] } {
  const time: number[] = [];
  const number: number[] = [];
  [...durations, unfinished].forEach((duration, index) => {
    for (let i = 0; i < Math.round(duration * 10); i++) {
      time.push(i / 10);
      number.push(index + 1);
    }
  });
  return { 'lap.time': time, 'lap.number': number };
}
