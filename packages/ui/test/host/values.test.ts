import {
  addSource,
  addVideo,
  createProject,
  createWidget,
  DataRangeSchema,
  dataRangeKey,
  embeddedSourceId,
  type Project,
  type TelemetrySeries,
  type VideoInfo,
} from '@custom-overlay/core';
import { describe, expect, it } from 'vitest';
import { evaluateProjectValues, projectMedia, rememberSource, rememberVideo } from '../../src/host/values';

function videoInfo(path: string): VideoInfo {
  return {
    path,
    fileName: path.slice(1),
    sizeBytes: 1,
    durationSeconds: 120,
    width: 1920,
    height: 1080,
    frameRate: 30,
    frameCount: 3600,
    codec: 'avc1',
    creationTime: null,
    hasGpmf: false,
    hasAudio: false,
    color: { space: 'rec709', range: 'limited', bitDepth: 8 },
    camera: { model: null, firmware: null },
    clock: [],
  };
}

/** Two minutes around a 100 m circle, one lap every 30 s. */
function logger(): TelemetrySeries {
  const time = Float64Array.from({ length: 1201 }, (_, i) => i / 10);
  const k = (Math.PI / 180) * 6_371_000;
  const angle = Array.from(time, (t) => (t / 30) * Math.PI * 2);
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
        values: Float64Array.from(angle, (a) => 42.43 + (100 * Math.sin(a)) / k),
      },
      {
        key: 'longitude',
        label: 'Longitude',
        unit: '°',
        time,
        values: Float64Array.from(
          angle,
          (a) => -8.65 + (100 * Math.cos(a)) / (k * Math.cos(42.43 * (Math.PI / 180))),
        ),
      },
      { key: 'speed', label: 'Speed', unit: 'm/s', time, values: time.map((t) => 20 + t / 10) },
      { key: 'lap', label: 'Lap', unit: '', time, values: time.map((t) => Math.floor(t / 30) + 1) },
    ],
    metadata: {},
  };
}

describe('projectMedia', () => {
  it('collects the media the renderer loaded, by project id', () => {
    const series = logger();
    const embedded = { ...logger(), kind: 'gopro' as const };
    let project = createProject();
    const withTelemetry = addVideo(project, {
      path: '/a.mp4',
      info: videoInfo('/a.mp4'),
      hasTelemetry: true,
    });
    project = withTelemetry.project;
    const plain = addVideo(project, { path: '/b.mp4', info: videoInfo('/b.mp4'), hasTelemetry: false });
    project = plain.project;
    const missing = addVideo(project, {
      path: '/never-loaded.mp4',
      info: videoInfo('/c.mp4'),
      hasTelemetry: false,
    });
    project = missing.project;
    const log = addSource(project, { kind: 'racechrono', path: '/log.csv' });
    project = log.project;
    const notLoaded = addSource(project, { kind: 'racechrono', path: '/other.csv' });
    project = notLoaded.project;

    rememberVideo('/a.mp4', videoInfo('/a.mp4'), embedded);
    rememberVideo('/b.mp4', videoInfo('/b.mp4'), null);
    rememberSource('/log.csv', 'racechrono', series);
    // Same path, another kind: not this source.
    rememberSource('/other.csv', 'dji', series);

    const media = projectMedia(project);
    expect(Object.keys(media.videos).sort()).toEqual([withTelemetry.video.id, plain.video.id].sort());
    expect(media.series).toEqual({
      [embeddedSourceId(withTelemetry.video.id)]: embedded,
      [log.source.id]: series,
    });
  });
});

describe('evaluateProjectValues', () => {
  function project(): Project {
    const added = addSource(createProject(), { kind: 'racechrono', path: '/circle.csv' });
    rememberSource('/circle.csv', 'racechrono', logger());
    const own = DataRangeSchema.parse({ start: { kind: 'time', time: 60 } });
    return {
      ...added.project,
      dataRange: DataRangeSchema.parse({ start: { kind: 'time', time: 30 } }),
      template: {
        ...added.project.template,
        widgets: [
          createWidget('value-text', { props: { template: '{speed|0}' } }),
          createWidget('value-text', { props: { template: '{speed|0}' }, dataRange: own }),
          createWidget('value-text', { props: { template: '{speed|0} {nothing|0}' }, dataRange: own }),
        ],
      },
    };
  }

  it('evaluates every value on the frame grid with the project data range', () => {
    const snapshot = evaluateProjectValues(project(), 10);
    expect(snapshot.grid.frameRate).toBe(10);
    expect(snapshot.grid.count).toBeGreaterThan(1000);
    expect(snapshot.values.map((v) => v.id)).toContain('speed');
    expect(snapshot.dataRange).toEqual({ start: 30, end: Number.POSITIVE_INFINITY });
    expect(snapshot.dataRangeProblems).toEqual([]);

    const speed = snapshot.data.speed as Float64Array;
    const frame = (time: number) => Math.round((time - snapshot.grid.start) * 10);
    expect(speed[frame(10)]).toBeNaN();
    expect(speed[frame(50)]).toBeCloseTo(25, 5);
  });

  it('adds the whole-session positions and laps', () => {
    const { full } = evaluateProjectValues(project(), 10);
    expect(Object.keys(full)).toEqual(expect.arrayContaining(['latitude', 'longitude']));
    expect(Number.isNaN(full.latitude?.[0])).toBe(false);
  });

  it('evaluates what widgets with their own data range read, once per range', () => {
    const p = project();
    const { ranges, grid } = evaluateProjectValues(p, 10);
    const key = dataRangeKey(p.template.widgets[1]?.dataRange);
    expect(Object.keys(ranges)).toEqual([key]);
    expect(Object.keys(ranges[key] ?? {})).toEqual(['speed']);
    const speed = ranges[key]?.speed as Float64Array;
    expect(speed[Math.round((50 - grid.start) * 10)]).toBeNaN();
    expect(speed[Math.round((90 - grid.start) * 10)]).toBeCloseTo(29, 5);
  });
});
