import { describe, expect, it } from 'vitest';
import { createProject, type Project, parseTrackFile, serializeTrackFile } from '../src/model/project.js';
import type { TelemetrySeries } from '../src/model/telemetry.js';
import { DEFAULT_TRACK, type Gate, type Track } from '../src/model/track.js';
import { addSource } from '../src/project-ops.js';
import { createValueEngine, type ValueEngine } from '../src/values/engine.js';
import {
  gateCrossings,
  lineLapSplits,
  resolveTimingFamily,
  suggestStartFinish,
  timingValueId,
} from '../src/values/timing.js';
import { createWidget, widgetInputs } from '../src/widgets/registry.js';
import { frameValue } from '../src/widgets/render.js';
import type { ProjectMedia } from '../src/workflow/timeline.js';
import { evaluateWorkflow } from '../src/workflow/workflow.js';

/**
 * A 100 m radius circle driven anticlockwise from its east point, one lap every 30 s, logged at
 * 10 Hz for 100 s. The logger's lap number changes at the east point (every 30 s).
 */
const LAT0 = 42.43;
const LON0 = -8.65;
const K = (Math.PI / 180) * 6_371_000;
const toGeo = (x: number, y: number) => ({
  latitude: LAT0 + y / K,
  longitude: LON0 + x / (K * Math.cos(LAT0 * (Math.PI / 180))),
});
/** A radial line across the circle at an angle (degrees anticlockwise from east). */
const radial = (degrees: number): Gate => {
  const a = (degrees * Math.PI) / 180;
  return { a: toGeo(80 * Math.cos(a), 80 * Math.sin(a)), b: toGeo(120 * Math.cos(a), 120 * Math.sin(a)) };
};

function logger(): TelemetrySeries {
  const time = new Float64Array(1001).map((_, i) => i / 10);
  const angle = time.map((t) => (t / 30) * Math.PI * 2);
  const geo = Array.from(angle, (a) => toGeo(100 * Math.cos(a), 100 * Math.sin(a)));
  return {
    kind: 'racechrono',
    name: 'circle',
    startEpochMs: 0,
    channels: [
      {
        key: 'latitude',
        label: 'Latitude',
        unit: '°',
        time,
        values: Float64Array.from(geo, (g) => g.latitude),
      },
      {
        key: 'longitude',
        label: 'Longitude',
        unit: '°',
        time,
        values: Float64Array.from(geo, (g) => g.longitude),
      },
      { key: 'lap', label: 'Lap', unit: '', time, values: time.map((t) => Math.floor(t / 30) + 1) },
    ],
    metadata: {},
  };
}

/** Start/finish at the north point (7.5 s into each turn), sectors at west and south. */
const TRACK: Track = { ...DEFAULT_TRACK, startFinish: radial(90), sectors: [radial(180), radial(270)] };

function engineFor(track: Partial<Track> = TRACK): ValueEngine {
  const added = addSource(createProject(), { kind: 'racechrono', path: '/circle.csv' });
  const project: Project = { ...added.project, track: { ...DEFAULT_TRACK, ...track } };
  const media: ProjectMedia = { videos: {}, series: { [added.source.id]: logger() } };
  return createValueEngine(project, media, { frameRate: 10 });
}

const at = (engine: ValueEngine, id: string, time: number) => engine.get(id)[engine.frameAt(time)] as number;

describe('timing lines', () => {
  it('finds line crossings in the driving direction, whatever way the line is drawn', () => {
    const { channels } = logger();
    const [lat, lon] = channels as [TelemetrySeries['channels'][0], TelemetrySeries['channels'][0]];
    const times = gateCrossings(lat, lon, radial(90), 10);
    expect(times).toHaveLength(4);
    times.forEach((t, k) => {
      expect(t).toBeCloseTo(7.5 + 30 * k, 1);
    });
    const gate = radial(90);
    expect(gateCrossings(lat, lon, { a: gate.b, b: gate.a }, 10)).toEqual(times);
    const splits = lineLapSplits(lat, lon, TRACK);
    expect(splits).toHaveLength(4);
    expect(splits[0]?.map((t) => Math.round(t * 10) / 10)).toEqual([7.5, 15, 22.5, 37.5]);
    expect(splits[3]?.[3]).toBeNaN();
    expect(lineLapSplits(lat, lon, DEFAULT_TRACK)).toEqual([]);
    // A minimum lap longer than a lap drops every other crossing.
    expect(gateCrossings(lat, lon, gate, 40)).toHaveLength(2);
  });

  it('times laps and sectors from the lines', () => {
    const engine = engineFor();
    expect(at(engine, 'lines.lap.number', 5)).toBeNaN();
    expect(at(engine, 'lines.lap.number', 40)).toBe(2);
    expect(at(engine, 'lines.lap.time', 20)).toBeCloseTo(12.5, 1);
    expect(at(engine, 'lines.lap.last', 40)).toBeCloseTo(30, 1);
    expect(at(engine, 'lines.lap.count', 0)).toBe(4);
    expect(at(engine, 'lines.sector.number', 20)).toBe(2);
    expect(at(engine, 'lines.sector.number', 30)).toBe(3);
    expect(at(engine, 'lines.sector.time', 30)).toBeCloseTo(7.5, 1);
    expect(at(engine, 'lines.sector.1.last', 40)).toBeCloseTo(7.5, 1);
    expect(at(engine, 'lines.sector.3.best', 40)).toBeCloseTo(15, 1);
    expect(at(engine, 'lines.sector.last', 40)).toBeCloseTo(15, 1);
    expect(at(engine, 'lines.lap.theoretical', 30)).toBeNaN();
    expect(at(engine, 'lines.lap.theoretical', 40)).toBeCloseTo(30, 1);
  });

  it('follows the project timing source with the plain ids', () => {
    // Lines: lap 2 started at 37.5 s. Logger: between the samples at 29.9 and 30 s.
    expect(at(engineFor(), 'lap.time', 40)).toBeCloseTo(2.5, 1);
    expect(at(engineFor({ ...TRACK, timing: 'imported' }), 'lap.time', 40)).toBeCloseTo(10.05, 6);
    expect(at(engineFor({ startFinish: null }), 'lap.time', 40)).toBeCloseTo(10.05, 6);
    expect(at(engineFor({ ...TRACK, startFinish: null }), 'sector.number', 40)).toBeNaN();
    expect(at(engineFor(), 'imported.lap.number', 40)).toBe(2);
    expect(at(engineFor({ startFinish: null }), 'lines.lap.time', 40)).toBeNaN();
    expect(engineFor({ sectors: [] }).has('lines.sector.number')).toBe(false);

    expect(resolveTimingFamily({ timing: 'auto', startFinish: null })).toBe('imported');
    expect(resolveTimingFamily({ timing: 'auto', startFinish: TRACK.startFinish })).toBe('lines');
    expect(resolveTimingFamily({ timing: 'imported', startFinish: TRACK.startFinish })).toBe('imported');
  });

  it('lets a widget read one timing family', () => {
    expect(timingValueId('lap.time', 'lines')).toBe('lines.lap.time');
    expect(timingValueId('speed.kmh', 'lines')).toBe('speed.kmh');
    expect(timingValueId('lap.time', null)).toBe('lap.time');
    const widget = createWidget('lap-timer', { timing: 'imported' });
    expect(widgetInputs(widget)).toEqual(['imported.lap.time', 'imported.lap.number']);
    const data: Record<string, Float64Array> = {
      'lap.time': Float64Array.of(1),
      'lines.lap.time': Float64Array.of(2),
    };
    const options = {
      frame: { series: { times: Float64Array.of(0), get: (id: string) => data[id] }, frameIndex: 0, time: 0 },
    };
    expect(frameValue(options)('lap.time')).toBe(1);
    expect(frameValue(options, 'lines')('lap.time')).toBe(2);
    expect(frameValue({ ...options, testValues: { 'lap.time': 9 } }, 'lines')('lap.time')).toBe(9);
    expect(frameValue({ ...options, testValues: { 'lines.lap.time': 8 } }, 'lines')('lap.time')).toBe(8);
  });

  it('suggests a start/finish line where the logger lap changes', () => {
    const engine = engineFor({ startFinish: null });
    const gate = suggestStartFinish(
      engine.get('latitude'),
      engine.get('longitude'),
      engine.get('lap'),
      15,
    ) as Gate;
    // Across the track at the east point: the line runs east-west (travel is northwards).
    const east = toGeo(100, 0);
    expect((gate.a.latitude + gate.b.latitude) / 2).toBeCloseTo(east.latitude, 4);
    expect((gate.a.longitude + gate.b.longitude) / 2).toBeCloseTo(east.longitude, 4);
    expect(Math.abs(gate.a.latitude - gate.b.latitude)).toBeLessThan(2e-5);
    expect(suggestStartFinish([1, 2], [1, 2], [1, 1])).toBeNull();
  });

  it('computes cornering and braking G from the GPS track', () => {
    // Anticlockwise (left turn) at 2π·100/30 m/s: v²/r = 0.447 g to the left, no speed change.
    const engine = engineFor({ startFinish: null });
    const v = (2 * Math.PI * 100) / 30;
    expect(at(engine, 'accel.lateral', 50)).toBeCloseTo(-(v * v) / 100 / 9.80665, 2);
    expect(at(engine, 'accel.longitudinal', 50)).toBeCloseTo(0, 3);
    expect(at(engine, 'accel.combined', 50)).toBeCloseTo((v * v) / 100 / 9.80665, 2);
  });

  it('reports the track step and round-trips track files', () => {
    const track = (project: Project) => evaluateWorkflow({ project }).find((s) => s.id === 'track');
    expect(track(createProject())?.state).toBe('skipped');
    expect(track(createProject({ track: TRACK }))?.state).toBe('complete');
    const missing = track(createProject({ track: { ...DEFAULT_TRACK, timing: 'lines' } }));
    expect(missing?.state).toBe('incomplete');
    expect(missing?.issues[0]?.severity).toBe('warning');

    const file = { version: 1 as const, track: { ...TRACK, name: 'Circle' } };
    expect(parseTrackFile(JSON.parse(serializeTrackFile(file)))).toEqual(file);
    expect(() => parseTrackFile({ version: 1, track: { sectors: [{}] } })).toThrow(/Invalid track file/);
  });
});
