import { describe, expect, it } from 'vitest';
import { createProject, embeddedSourceId, type Project, parseValueCollection } from '../src/model/project.js';
import type { TelemetrySeries } from '../src/model/telemetry.js';
import type { ValueScript } from '../src/model/values.js';
import { addSource, addVideo, setItemOffset } from '../src/project-ops.js';
import { createValueEngine, frameGrid, normalizeOutput, type ValueEngine } from '../src/values/engine.js';
import type { ProjectMedia } from '../src/workflow/timeline.js';
import { videoInfo } from './helpers/fixtures.js';

/** Logger: speed 20 m/s from 0..200 s, laps change at 60 s and 125 s (10 Hz). */
function logger(): TelemetrySeries {
  const n = 2000;
  const time = new Float64Array(n).map((_, i) => i / 10);
  const lap = time.map((t) => (t < 60 ? 1 : t < 125 ? 2 : 3));
  return {
    kind: 'racechrono',
    name: 'log',
    startEpochMs: 1_000_000,
    channels: [
      { key: 'speed', label: 'Speed', unit: 'm/s', time, values: new Float64Array(n).fill(20) },
      { key: 'lap', label: 'Lap #', unit: '', time, values: lap },
      { key: 'speed_obd', label: 'Speed', unit: 'm/s', time, values: new Float64Array(n).fill(19) },
    ],
    metadata: {},
  };
}

/** GoPro telemetry: speed 10 m/s for 100 s (1 Hz). */
function gopro(): TelemetrySeries {
  const time = new Float64Array(101).map((_, i) => i);
  return {
    kind: 'gopro',
    name: 'GX01',
    startEpochMs: null,
    channels: [
      { key: 'speed', label: 'Speed (2D)', unit: 'm/s', time, values: new Float64Array(101).fill(10) },
    ],
    metadata: {},
  };
}

function setup(scripts: ValueScript[] = [], loggerOffset = 0): { project: Project; media: ProjectMedia } {
  const v = addVideo(createProject(), {
    path: '/GX010042.MP4',
    info: videoInfo({ durationSeconds: 100 }),
    hasTelemetry: true,
  });
  const log = addSource(v.project, { kind: 'racechrono', path: '/log.csv' });
  const project = { ...setItemOffset(log.project, log.source.id, loggerOffset), values: scripts };
  return {
    project,
    media: {
      videos: { [v.video.id]: videoInfo({ durationSeconds: 100 }) },
      series: { [embeddedSourceId(v.video.id)]: gopro(), [log.source.id]: logger() },
    },
  };
}

function script(id: string, code: string, extra: Partial<ValueScript> = {}): ValueScript {
  return { id, name: id, description: '', unit: '', initial: null, code, ...extra };
}

function at(engine: ValueEngine, id: string, time: number): number | undefined {
  return engine.get(id)[engine.frameAt(time)];
}

describe('frames', () => {
  it('covers the timeline at the requested rate', () => {
    expect(frameGrid(0, 1, 10).count).toBe(11);
    expect(frameGrid(-1, 1, 2).times).toEqual(Float64Array.from([-1, -0.5, 0, 0.5, 1]));
    expect(frameGrid(0, 0, 30).count).toBe(0);
  });

  it('normalizes outputs', () => {
    expect(Array.from(normalizeOutput([1, null, true, undefined], 4))).toEqual([
      1,
      Number.NaN,
      1,
      Number.NaN,
    ]);
    expect(Array.from(normalizeOutput(7, 2))).toEqual([7, 7]);
    expect(normalizeOutput(null, 2).every(Number.isNaN)).toBe(true);
    expect(() => normalizeOutput([1], 2)).toThrow(/expected one per frame/);
    expect(() => normalizeOutput('x' as never, 2)).toThrow(/must return/);
  });
});

describe('source values', () => {
  it('lists per kind and best available values', () => {
    const { project, media } = setup();
    const ids = createValueEngine(project, media, { frameRate: 10 })
      .list()
      .map((v) => `${v.origin}:${v.id}`);
    expect(ids).toEqual(
      expect.arrayContaining([
        'source:gopro.speed',
        'source:racechrono.speed',
        'source:racechrono.speed_obd',
        'source:racechrono.lap',
        'source:speed',
        'source:lap',
        'builtin:lap.time',
      ]),
    );
  });

  it('prefers the logger and falls back to the camera', () => {
    // Logger starts 150 s before the video: it covers timeline -150..50.
    const { project, media } = setup([], -150);
    const engine = createValueEngine(project, media, { frameRate: 10 });
    expect(at(engine, 'speed', 10)).toBe(20);
    expect(at(engine, 'speed', 80)).toBe(10);
    expect(at(engine, 'gopro.speed', 10)).toBe(10);
    expect(engine.grid.start).toBeCloseTo(-150, 6);
  });

  it('holds discrete values instead of interpolating', () => {
    const { project, media } = setup();
    const engine = createValueEngine(project, media, { frameRate: 100 });
    expect(at(engine, 'lap', 59.95)).toBe(1);
    expect(at(engine, 'lap', 60.01)).toBe(2);
  });
});

describe('builtin values', () => {
  const { project, media } = setup();
  const engine = createValueEngine(project, media, { frameRate: 10 });

  it('computes lap values from the exact lap changes', () => {
    expect(at(engine, 'lap.number', 70)).toBe(2);
    expect(at(engine, 'lap.time', 30)).toBeNaN();
    expect(at(engine, 'lap.time', 70)).toBeCloseTo(10.05, 6);
    expect(at(engine, 'lap.last', 70)).toBeNaN();
    expect(at(engine, 'lap.last', 130)).toBeCloseTo(65, 6);
    expect(at(engine, 'lap.best', 130)).toBeCloseTo(65, 6);
    expect(at(engine, 'lap.count', 0)).toBe(3);
    expect(at(engine, 'lap.remaining', 70)).toBe(1);
  });

  it('computes time and unit values', () => {
    expect(at(engine, 'speed.kmh', 10)).toBeCloseTo(72, 6);
    expect(at(engine, 'speed.mph', 10)).toBeCloseTo(44.74, 2);
    expect(at(engine, 'time.clock', 10)).toBe(1_010_000);
    expect(at(engine, 'time.frame', 10)).toBe(100);
    expect(at(engine, 'session.elapsed', 10)).toBeCloseTo(10, 6);
    expect(at(engine, 'session.remaining', 199.9)).toBeCloseTo(0, 6);
    expect(at(engine, 'accel.combined', 10)).toBeNaN();
    expect(engine.error('accel.combined')).toBeUndefined();
  });

  it('keeps the top speed so far and ignores GPS spikes', () => {
    const { project, media } = setup();
    const log = Object.values(media.series).find((s) => s?.kind === 'racechrono');
    const speed = log?.channels.find((c) => c.key === 'speed');
    if (!speed) throw new Error('logger speed missing');
    // Up to 30 m/s at 50 s, slowing down after; a one-sample spike to 90 m/s at 80 s.
    speed.values = speed.time.map((t) => (t <= 50 ? 10 + 0.4 * t : 30 - 0.2 * (t - 50)));
    speed.values[800] = 90;
    const top = createValueEngine(project, media, { frameRate: 10 });
    expect(at(top, 'speed.top.kmh', 25)).toBeCloseTo(72, 6);
    expect(at(top, 'speed.top.kmh', 70)).toBeCloseTo(108, 6);
    expect(at(top, 'speed.top.kmh', 95)).toBeCloseTo(108, 6);
    expect(at(top, 'speed.top.mph', 95)).toBeCloseTo(67.11, 2);
  });

  it('stays empty without the inputs', () => {
    const empty = createValueEngine(createProject(), { videos: {}, series: {} });
    expect(empty.grid.count).toBe(0);
    expect(empty.evaluate(['lap.time', 'speed.kmh']).errors).toEqual({});
  });
});

describe('value scripts', () => {
  it('computes from other values, in any order, with initial values', () => {
    const { project, media } = setup([
      script('speed.double', 'return ctx.get("speed.half").map((v) => v * 4);'),
      script('speed.half', 'return ctx.get("speed").map((v) => v / 2);'),
      script('const.answer', 'return 42;'),
      // Float64Array.map would turn null into 0: build a plain array instead.
      script('maybe', 'return Array.from(ctx.times, (t) => (t < 100 ? 1 : null));', { initial: -1 }),
    ]);
    const engine = createValueEngine(project, media, { frameRate: 10 });
    expect(at(engine, 'speed.double', 10)).toBe(40);
    expect(at(engine, 'const.answer', 0)).toBe(42);
    expect(at(engine, 'maybe', 50)).toBe(1);
    expect(at(engine, 'maybe', 150)).toBe(-1);
    expect(engine.list().find((v) => v.id === 'maybe')).toMatchObject({ origin: 'script', initial: -1 });
  });

  it('gives scripts the frame grid, raw samples and copies of values', () => {
    const { project, media } = setup([
      script('raw.count', 'return ctx.raw("racechrono.lap").time.length;'),
      script('mutate', 'const s = ctx.get("speed"); s.fill(0); return ctx.get("speed");'),
      script(
        'info',
        'return ctx.info("speed").unit === "m/s" && ctx.has("lap") && ctx.raw("lap.time") === null;',
      ),
      script('meta', 'return ctx.frameCount === ctx.times.length && ctx.frameRate === 10 ? ctx.start : -1;'),
    ]);
    const engine = createValueEngine(project, media, { frameRate: 10 });
    expect(at(engine, 'raw.count', 0)).toBe(2000);
    expect(at(engine, 'mutate', 10)).toBe(20);
    expect(at(engine, 'info', 0)).toBe(1);
    expect(at(engine, 'meta', 0)).toBe(0);
  });

  it('reports errors per value', () => {
    const { project, media } = setup([
      script('bad.syntax', 'return (;'),
      script('bad.throw', 'throw new Error("boom");'),
      script('bad.length', 'return [1, 2];'),
      script('bad.unknown', 'return ctx.get("nope");'),
      script('loop.a', 'return ctx.get("loop.b");'),
      script('loop.b', 'return ctx.get("loop.a");'),
      script('after.error', 'return ctx.get("bad.throw").map(() => 1);'),
    ]);
    const engine = createValueEngine(project, media, { frameRate: 1 });
    const { errors, data } = engine.evaluate([
      'bad.syntax',
      'bad.throw',
      'bad.length',
      'bad.unknown',
      'loop.a',
      'loop.b',
      'after.error',
      'missing',
    ]);
    expect(errors['bad.syntax']).toMatch(/syntax error/);
    expect(errors['bad.throw']).toBe('boom');
    expect(errors['bad.length']).toMatch(/expected one per frame/);
    expect(errors['bad.unknown']).toBe("unknown value 'nope'");
    expect(errors['loop.a']).toBe('circular dependency: loop.a → loop.b → loop.a');
    expect(errors['loop.b']).toBe(errors['loop.a']);
    expect(errors['after.error']).toBeUndefined();
    expect(errors.missing).toBe("unknown value 'missing'");
    expect(data['bad.throw']?.every(Number.isNaN)).toBe(true);
    expect(() => engine.get('missing')).toThrow(/unknown value/);
  });

  it('lets project values override template and builtin values', () => {
    const { project, media } = setup([script('lap.time', 'return 1;'), script('custom', 'return 2;')]);
    const withTemplate = {
      ...project,
      template: { ...project.template, values: [script('custom', 'return 3;')] },
    };
    const engine = createValueEngine(withTemplate, media, { frameRate: 1 });
    expect(engine.list().find((v) => v.id === 'lap.time')).toMatchObject({
      origin: 'script',
      overrides: 'builtin',
    });
    expect(at(engine, 'custom', 0)).toBe(2);
    expect(at(engine, 'lap.time', 0)).toBe(1);
  });

  it('validates value collections', () => {
    const collection = parseValueCollection({
      version: 1,
      values: [{ id: 'lap.delta', name: 'Delta', code: 'return 0;' }],
    });
    expect(collection.values[0]).toMatchObject({ initial: null, unit: '', description: '' });
    expect(() => parseValueCollection({ version: 1, values: [{ id: '1bad', name: 'x', code: '' }] })).toThrow(
      /dotted names/,
    );
  });
});

describe('distance traveled', () => {
  it('integrates GPS positions while moving and ignores standstill jitter', () => {
    const n = 201;
    const time = new Float64Array(n).map((_, i) => i / 10);
    // 10 s parked with jitter, then 10 s heading north at 10 m/s.
    const lat = time.map((t, i) => 42 + (t < 10 ? (i % 2) * 2e-6 : ((t - 10) * 10) / 111_195));
    const speed = time.map((t) => (t < 10 ? 0.2 : 10));
    const series: TelemetrySeries = {
      kind: 'racechrono',
      name: 'gps',
      startEpochMs: null,
      channels: [
        { key: 'latitude', label: 'Latitude', unit: 'deg', time, values: lat },
        { key: 'longitude', label: 'Longitude', unit: 'deg', time, values: new Float64Array(n).fill(-8) },
        { key: 'speed', label: 'Speed', unit: 'm/s', time, values: speed },
      ],
      metadata: {},
    };
    const { project, source } = addSource(createProject(), { kind: 'racechrono', path: '/gps.csv' });
    const engine = createValueEngine(
      project,
      { videos: {}, series: { [source.id]: series } },
      { frameRate: 10 },
    );
    expect(at(engine, 'distance.traveled', 9)).toBeCloseTo(0, 6);
    expect(at(engine, 'distance.traveled', 20)).toBeCloseTo(100, 0);
  });
});
