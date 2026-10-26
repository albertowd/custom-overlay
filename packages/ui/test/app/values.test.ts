import { createWidget, type DataRange, dataRangeKey } from '@custom-overlay/core';
import { describe, expect, it } from 'vitest';
import { fullSeries, snapshotSeries, snapshotValue, widgetSeries } from '../../src/app/values';
import { valuesSnapshot } from './helpers/project';

describe('snapshotValue', () => {
  const snapshot = valuesSnapshot({ speed: [10, 20, 30, 40] }, { start: 2, frameRate: 10 });

  it('reads the nearest frame', () => {
    expect(snapshotValue(snapshot, 'speed', 2)).toBe(10);
    expect(snapshotValue(snapshot, 'speed', 2.14)).toBe(20);
    expect(snapshotValue(snapshot, 'speed', 2.16)).toBe(30);
  });

  it('clamps to the first and last frames', () => {
    expect(snapshotValue(snapshot, 'speed', 0)).toBe(10);
    expect(snapshotValue(snapshot, 'speed', 100)).toBe(40);
  });

  it('is NaN for unknown values and empty grids', () => {
    expect(snapshotValue(snapshot, 'rpm', 2)).toBeNaN();
    expect(snapshotValue(valuesSnapshot({}, { count: 0 }), 'speed', 0)).toBeNaN();
  });
});

describe('snapshotSeries', () => {
  it('builds the frame times and reads the data', () => {
    const snapshot = valuesSnapshot({ speed: [1, 2, 3] }, { start: 5, frameRate: 2 });
    const series = snapshotSeries(snapshot);
    expect([...series.times]).toEqual([5, 5.5, 6]);
    expect(series.get('speed')).toBe(snapshot.data.speed);
    expect(series.get('rpm')).toBeUndefined();
  });
});

describe('fullSeries', () => {
  it('reads the whole-session data and is the same object for the same snapshot', () => {
    const snapshot = { ...valuesSnapshot({ speed: [1, 2] }), full: { latitude: Float64Array.of(10, 11) } };
    const series = fullSeries(snapshot);
    expect(series.get('latitude')).toBe(snapshot.full.latitude);
    expect(series.get('speed')).toBeUndefined();
    expect(fullSeries(snapshot)).toBe(series);
    expect(fullSeries({ ...snapshot })).not.toBe(series);
  });
});

describe('widgetSeries', () => {
  const range: DataRange = { start: { kind: 'lap', lap: 2, fromEnd: false }, end: null };

  it('uses the base series for widgets without a data range', () => {
    const snapshot = valuesSnapshot({ speed: [1] });
    const base = snapshotSeries(snapshot);
    expect(widgetSeries(snapshot, base, createWidget('text'))).toBe(base);
  });

  it("reads a widget's own data range, cached per range", () => {
    const widget = { ...createWidget('lap-table'), dataRange: range };
    const key = dataRangeKey(widget.dataRange);
    const ranged = { speed: Float64Array.of(7, 8) };
    const snapshot = { ...valuesSnapshot({ speed: [1, 2] }), ranges: { [key]: ranged } };
    const base = snapshotSeries(snapshot);
    const series = widgetSeries(snapshot, base, widget);
    expect(series).not.toBe(base);
    expect(series.get('speed')).toBe(ranged.speed);
    expect(widgetSeries(snapshot, base, widget)).toBe(series);
  });

  it('falls back to the base series when the range was not evaluated', () => {
    const snapshot = valuesSnapshot({ speed: [1] });
    const base = snapshotSeries(snapshot);
    expect(widgetSeries(snapshot, base, { dataRange: range })).toBe(base);
  });
});
