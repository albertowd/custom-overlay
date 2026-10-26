import { describe, expect, it } from 'vitest';
import { DataRangeSchema, resolveDataRange } from '../src/model/data-range.js';
import { createProject, createTemplate, type Project } from '../src/model/project.js';
import type { TelemetrySeries } from '../src/model/telemetry.js';
import { addSource } from '../src/project-ops.js';
import type { ValueEngine } from '../src/values/engine.js';
import { ProjectValues } from '../src/values/ranged.js';
import { createWidget } from '../src/widgets/registry.js';
import { renderOverlay } from '../src/widgets/render.js';
import type { ProjectMedia } from '../src/workflow/timeline.js';
import { recordingContext } from './helpers/canvas.js';

/**
 * A 100 m radius circle driven at 20.9 m/s, one lap every 30 s, logged at 10 Hz for 100 s. The
 * logger's lap number changes every 30 s: laps start at 29.95, 59.95 and 89.95 s (the last one
 * unfinished).
 */
function logger(): TelemetrySeries {
  const time = new Float64Array(1001).map((_, i) => i / 10);
  const k = (Math.PI / 180) * 6_371_000;
  const angle = time.map((t) => (t / 30) * Math.PI * 2);
  const lat = angle.map((a) => 42.43 + (100 * Math.sin(a)) / k);
  const lon = angle.map((a) => -8.65 + (100 * Math.cos(a)) / (k * Math.cos(42.43 * (Math.PI / 180))));
  return {
    kind: 'racechrono',
    name: 'circle',
    startEpochMs: 0,
    channels: [
      { key: 'latitude', label: 'Latitude', unit: '°', time, values: lat },
      { key: 'longitude', label: 'Longitude', unit: '°', time, values: lon },
      { key: 'speed', label: 'Speed', unit: 'm/s', time, values: time.map(() => (2 * Math.PI * 100) / 30) },
      { key: 'lap', label: 'Lap', unit: '', time, values: time.map((t) => Math.floor(t / 30) + 1) },
    ],
    metadata: {},
  };
}

function setup(dataRange: Partial<Project['dataRange']> = {}): { project: Project; media: ProjectMedia } {
  const added = addSource(createProject(), { kind: 'racechrono', path: '/circle.csv' });
  const project: Project = { ...added.project, dataRange: DataRangeSchema.parse(dataRange) };
  return { project, media: { videos: {}, series: { [added.source.id]: logger() } } };
}

const at = (engine: ValueEngine, id: string, time: number) => engine.get(id)[engine.frameAt(time)] as number;

/** From the 2nd lap to the end of the last completed lap: 59.95 → 89.95 s. */
const FROM_LAP_2: Partial<Project['dataRange']> = {
  start: { kind: 'lap', lap: 2, fromEnd: false },
  end: { kind: 'lap', lap: 1, fromEnd: true },
};

describe('data ranges', () => {
  it('resolves time and lap bounds, and reports laps that do not exist', () => {
    const laps = [
      { start: 10, duration: 30 },
      { start: 40, duration: 31 },
      { start: 71, duration: 29 },
      { start: 100, duration: Number.NaN },
    ];
    const resolve = (range: Partial<Project['dataRange']>) =>
      resolveDataRange(DataRangeSchema.parse(range), laps);
    expect(resolve({ start: { kind: 'lap', lap: 2, fromEnd: false } }).range).toEqual({
      start: 40,
      end: Infinity,
    });
    // Two laps before the end: the end of the 3rd completed lap from the end.
    expect(resolve({ end: { kind: 'lap', lap: 3, fromEnd: true } }).range).toEqual({
      start: -Infinity,
      end: 40,
    });
    expect(
      resolve({ start: { kind: 'time', time: 12.5 }, end: { kind: 'lap', lap: 3, fromEnd: false } }).range,
    ).toEqual({
      start: 12.5,
      end: 100,
    });
    const missing = resolve({ start: { kind: 'lap', lap: 9, fromEnd: false } });
    expect(missing.range.start).toBe(-Infinity);
    expect(missing.problems).toEqual([{ code: 'lapMissing', bound: 'start', lap: 9, fromEnd: false }]);
    expect(resolve({ start: { kind: 'time', time: 50 }, end: { kind: 'time', time: 20 } }).problems).toEqual([
      { code: 'empty' },
    ]);
  });

  it('starts the session over inside the range', () => {
    const values = new ProjectValues(...(Object.values(setup(FROM_LAP_2)) as [Project, ProjectMedia]), {
      frameRate: 10,
    });
    expect(values.resolve(setup(FROM_LAP_2).project.dataRange).range).toEqual({ start: 59.95, end: 89.95 });
    const engine = values.engine;
    // Laps numbered from the first kept lap, counted and timed inside the range only.
    expect(at(engine, 'lap.number', 70)).toBe(1);
    expect(at(engine, 'lap.count', 70)).toBe(1);
    expect(at(engine, 'lap.time', 70)).toBeCloseTo(10.05, 6);
    expect(at(engine, 'lap.remaining', 70)).toBe(0);
    // Distance and session times from the start of the range.
    expect(at(engine, 'distance.traveled', 60)).toBeCloseTo(0, 0);
    expect(at(engine, 'distance.traveled', 70)).toBeCloseTo(((2 * Math.PI * 100) / 30) * 10.05, -1);
    expect(at(engine, 'session.elapsed', 70)).toBeCloseTo(10.05, 6);
    expect(at(engine, 'session.remaining', 70)).toBeCloseTo(19.95, 6);
    // No data outside the range; the timeline is not data.
    for (const id of ['speed', 'latitude', 'lap.number', 'distance.traveled', 'speed.kmh']) {
      expect(at(engine, id, 40), id).toBeNaN();
      expect(at(engine, id, 95), id).toBeNaN();
    }
    expect(at(engine, 'time.timeline', 40)).toBe(40);
    // The whole session is still there.
    expect(at(values.full, 'lap.number', 40)).toBe(2);
    expect(at(values.full, 'speed', 40)).toBeGreaterThan(20);
  });

  it('gives each widget its own range or the project one, reusing values per range', () => {
    const { project, media } = setup(FROM_LAP_2);
    const values = new ProjectValues(project, media, { frameRate: 10 });
    const own = { dataRange: DataRangeSchema.parse({ start: { kind: 'time', time: 10 } }) };
    expect(values.seriesFor({ dataRange: null })).toBe(values.seriesOf(values.engine));
    expect(values.seriesFor(own)).toBe(values.seriesFor(own));
    expect(values.seriesFor(own)).not.toBe(values.seriesFor({ dataRange: null }));

    // At 40 s the project range has no data, the widget with its own range does.
    const template = createTemplate({
      widgets: [
        createWidget('value-text', { props: { template: 'P {speed|0}' } }),
        createWidget('value-text', { props: { template: 'W {speed|0}' }, ...own }),
      ],
    });
    const rec = recordingContext();
    renderOverlay(rec.ctx, {
      width: 640,
      height: 360,
      template,
      palette: project.palette,
      frame: {
        series: values.seriesOf(values.engine),
        seriesFor: (widget) => values.seriesFor(widget),
        frameIndex: values.engine.frameAt(40),
        time: 40,
      },
      utcOffsetMinutes: 0,
    });
    expect(rec.texts()).toEqual(['P —', 'W 21']);
  });
});
