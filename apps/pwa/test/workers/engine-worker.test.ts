import { readFile } from 'node:fs/promises';
import { addSource, addVideo, createProject, type Project } from '@custom-overlay/core';
import type { ValuesSnapshot } from '@custom-overlay/ui/api';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { videoInfo } from '../../../../packages/core/test/helpers/fixtures';
import { buildMp4 } from '../../../../packages/core/test/helpers/mp4-builder';
import type { EngineOperations, EngineRequest, EngineResponse } from '../../src/engine-protocol';
import { workerScope } from './worker-scope';

const DJI_SRT = new URL('../../../../packages/core/test/fixtures/dji/mini5pro-clip.srt', import.meta.url);

const RACECHRONO = [
  'This file is created using RaceChrono v8.1.2 ( http://www.racechrono.com/ ).',
  'Format,3',
  'Session title,"Track day"',
  'Session type,Lap timing',
  'Track name,"Interlagos"',
  'Created,01/05/2024,10:00',
  '',
  'Timestamp,Fragment ID,Lap #,Elapsed time,Distance traveled,Latitude,Longitude,Speed',
  'unix time,,,s,m,deg,deg,m/s',
  ',,,,,100: gps,100: gps,100: gps',
  ...Array.from(
    { length: 40 },
    (_, i) => `${1714557600 + i * 0.1},0,1,${(i * 0.1).toFixed(1)},${i},-23.70,-46.69,${10 + i}`,
  ),
].join('\r\n');

/** A 1280×720 video of one second without telemetry. */
const plainVideo = () => <Uint8Array<ArrayBuffer>>buildMp4([
    {
      id: 1,
      handler: 'vide',
      format: 'avc1',
      timescale: 30000,
      sampleDelta: 1000,
      samples: Array.from({ length: 30 }, () => new Uint8Array(1)),
      width: 1280,
      height: 720,
    },
  ]);

let scope: ReturnType<typeof workerScope<EngineRequest, EngineResponse>>;
let nextId = 0;

/** Run an operation in the worker; resolves with its answer. */
async function run<K extends keyof EngineOperations>(operation: K, args: EngineOperations[K]['args']) {
  const id = nextId++;
  const answer = scope.next();
  scope.post({ id, operation, args } as EngineRequest);
  const response = await answer;
  expect(response.id).toBe(id);
  return response as EngineResponse & { result: EngineOperations[K]['result'] };
}

beforeAll(async () => {
  scope = workerScope<EngineRequest, EngineResponse>();
  await import('../../src/engine.worker');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('engine worker', () => {
  it('reads a video from a browser File, with the DJI subtitles picked with it', async () => {
    const subtitles = new File([await readFile(DJI_SRT, 'utf8')], 'DJI_0001.SRT');
    const response = await run('loadVideo', {
      path: 'DJI_0001.MP4',
      file: new File([plainVideo()], 'DJI_0001.MP4'),
      subtitles,
    });
    expect(response.ok).toBe(true);
    expect(response.result.info).toMatchObject({ fileName: 'DJI_0001.MP4', width: 1280, height: 720 });
    expect(response.result.telemetry?.kind).toBe('dji');
  });

  it('reads data sources', async () => {
    const response = await run('loadSource', {
      path: 'lap.csv',
      kind: 'racechrono',
      file: new File([RACECHRONO], 'lap.csv'),
      subtitles: null,
    });
    expect(response.ok).toBe(true);
    expect(response.result.kind).toBe('racechrono');
    expect(response.result.name).toBe('Track day');
  });

  it('answers with the error of a failed operation', async () => {
    const response = await run('loadSource', {
      path: 'clip.mp4',
      kind: 'gopro',
      file: new File([plainVideo()], 'clip.mp4'),
      subtitles: null,
    });
    expect(response).toMatchObject({
      ok: false,
      message: "'clip.mp4' has no telemetry (GoPro GPMF or a DJI .SRT file next to it)",
    });
  });

  describe('with a loaded data source', () => {
    let project: Project;

    beforeAll(async () => {
      project = addSource(createProject(), { kind: 'racechrono', path: 'lap.csv' }).project;
      await run('loadSource', {
        path: 'lap.csv',
        kind: 'racechrono',
        file: new File([RACECHRONO], 'lap.csv'),
        subtitles: null,
      });
    });

    it('evaluates the project values with the media it kept', async () => {
      const response = await run('evaluateValues', { project, frameRate: 10 });
      expect(response.ok).toBe(true);
      const snapshot = response.result as ValuesSnapshot;
      expect(snapshot.grid.frameRate).toBe(10);
      expect(snapshot.grid.count).toBeGreaterThan(30);
      expect(snapshot.values.map((v) => v.id)).toContain('speed');
      expect(Array.from(snapshot.data.speed ?? []).some((v) => v > 10)).toBe(true);
    });

    it('plans an image sequence over the session and hands out its media', async () => {
      const response = await run('imageSequence', { project });
      expect(response.ok).toBe(true);
      const { plan, media } = response.result;
      expect(plan).toMatchObject({ width: project.output.width, height: project.output.height, start: 0 });
      expect(plan.frames).toBe(Math.round(3.9 * project.output.frameRate));
      expect(Object.keys(media.series)).toEqual([project.sources[0]?.id]);
    });

    it('leaves out media this tab did not load', async () => {
      const path = 'missing.mp4';
      const withVideo = addVideo(project, { path, info: videoInfo({ path }), hasTelemetry: false }).project;
      const { result } = await run('imageSequence', { project: withVideo });
      expect(result.media.videos).toEqual({});
    });
  });
});
