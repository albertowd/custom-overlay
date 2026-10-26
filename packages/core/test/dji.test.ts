import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject } from '../src/model/project.js';
import { getChannel } from '../src/model/telemetry.js';
import { detectSourceKind, findDjiSubtitles, loadSourceFile, loadVideo } from '../src/node/index.js';
import { addVideo } from '../src/project-ops.js';
import { isDjiSrt, parseDjiSrt, parseDjiSubtitle } from '../src/sources/dji-srt.js';
import { createValueEngine } from '../src/values/engine.js';
import { buildMp4 } from './helpers/mp4-builder.js';

/** Real subtitles from DJI aircraft (see fixtures/dji/NOTICE.md). */
const fixture = (name: string) => readFile(new URL(`./fixtures/dji/${name}`, import.meta.url), 'utf8');
const first = (series: ReturnType<typeof parseDjiSrt>, key: string) =>
  getChannel(series, key)?.values.find((v) => Number.isFinite(v));

describe('DJI telemetry subtitles', () => {
  it('reads the bracketed layout of the Mini / Air / Mavic drones', async () => {
    const series = parseDjiSrt(await fixture('legacy-sample.srt'), 'legacy.srt');
    expect(series.kind).toBe('dji');
    expect(getChannel(series, 'latitude')?.time.length).toBe(5);
    expect(first(series, 'latitude')).toBe(59.302335);
    expect(first(series, 'longitude')).toBe(18.203059);
    expect(first(series, 'altitude')).toBe(132.86);
    expect(first(series, 'relativeAltitude')).toBe(1.3);
    expect(first(series, 'iso')).toBe(2700);
    expect(first(series, 'shutter')).toBeCloseTo(1 / 30, 10);
    // Older firmwares write the f-number x100.
    expect(first(series, 'fNumber')).toBe(1.7);
    expect(getChannel(series, 'latitude')?.time[1]).toBeCloseTo(0.033, 6);
  });

  it('reads the HTML-wrapped layouts, old and new', async () => {
    const mavic = parseDjiSrt(await fixture('mavic4pro-clip.srt'), 'mavic.srt');
    expect(first(mavic, 'fNumber')).toBe(2.8);
    expect(first(mavic, 'focalLength')).toBe(28);
    expect(first(mavic, 'ev')).toBe(-0.3);
    expect(first(mavic, 'colorTemperature')).toBe(5574);
    expect(mavic.metadata.clock).toBe('2026-08-23 17:22:01.253');
    const air3 = parseDjiSrt(await fixture('air3-clip.srt'), 'air3.srt');
    expect(first(air3, 'latitude')).toBe(59.1111);
    expect(first(air3, 'fNumber')).toBe(2.8);
    const avata360 = parseDjiSrt(await fixture('avata360-clip.srt'), 'avata.srt');
    expect(first(avata360, 'altitude')).toBe(-124.744);
    expect(first(avata360, 'gimbalYaw')).toBe(-162.8);
    expect(first(avata360, 'digitalZoom')).toBe(1);
  });

  it('reads the GPS(...) layout with home point and barometer', async () => {
    const series = parseDjiSrt(await fixture('avata2-clip.srt'), 'avata2.srt');
    expect(first(series, 'latitude')).toBe(39.906217);
    expect(first(series, 'altitude')).toBe(69.8);
    expect(first(series, 'barometerAltitude')).toBe(91.2);
    expect(first(series, 'homeLongitude')).toBe(116.3914);
  });

  it('reads the compact Phantom / Matrice line, with speeds and attitudes', () => {
    const { sample } = parseDjiSubtitle(
      'GPS (-58.851745, -34.237922, 15), D 12.3m, H 4.5m, H.S 3.2m/s, V.S -0.5m/s, F.PRY (1.2°, -0.5°, 90.1°), G.PRY (-30.0°, 0.0°, 90.1°), F/5.6, SS 400, ISO 100, EV 0',
    );
    expect(sample).toMatchObject({
      latitude: -58.851745,
      longitude: -34.237922,
      altitude: 15,
      homeDistance: 12.3,
      height: 4.5,
      speed: 3.2,
      verticalSpeed: -0.5,
      aircraftPitch: 1.2,
      aircraftYaw: 90.1,
      gimbalPitch: -30,
      fNumber: 5.6,
      shutter: 1 / 400,
      iso: 100,
      ev: 0,
    });
    // Legacy-with-unit altitude and barometer.
    expect(parseDjiSubtitle('GPS(36.6146,-6.1120,0.0M) BAROMETER:0.3M').sample).toMatchObject({
      latitude: 36.6146,
      altitude: 0,
      barometer: 0.3,
    });
    expect(parseDjiSubtitle('[latitude : 1.5] [longtitude : 2.5]').sample).toMatchObject({
      latitude: 1.5,
      longitude: 2.5,
    });
  });

  it('treats 0, 0 as no GPS fix and derives the speed from the positions', async () => {
    const nogps = parseDjiSrt(await fixture('neo2-clip_nogps.srt'), 'neo.srt');
    expect(getChannel(nogps, 'latitude')?.values[0]).toBeNaN();
    const legacy = parseDjiSrt(await fixture('legacy-sample.srt'), 'legacy.srt');
    const speed = getChannel(legacy, 'speed');
    expect(speed?.label).toBe('Speed (from GPS)');
    // About 0.1 m per 33 ms in the sample: a walking pace.
    expect(speed?.values[2]).toBeGreaterThan(0.5);
    expect(speed?.values[2]).toBeLessThan(10);
  });

  it('recognizes DJI subtitles, and rejects other files', async () => {
    expect(isDjiSrt(await fixture('mini5pro-clip.srt'))).toBe(true);
    expect(isDjiSrt('1\n00:00:01,000 --> 00:00:02,000\nHello there\n')).toBe(false);
    expect(() => parseDjiSrt('not subtitles', 'x.srt')).toThrow(/no DJI telemetry/);
  });
});

describe('DJI videos', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'custom-overlay-dji-'));
    const frames = Array.from({ length: 30 }, () => new Uint8Array(1));
    const video = buildMp4([
      {
        id: 1,
        handler: 'vide',
        format: 'avc1',
        timescale: 30000,
        sampleDelta: 1001,
        samples: frames,
        width: 1920,
        height: 1080,
      },
    ]);
    await writeFile(join(dir, 'DJI_0001.MP4'), video);
    await copyFile(new URL('./fixtures/dji/mavic4pro-clip.srt', import.meta.url), join(dir, 'DJI_0001.SRT'));
    await writeFile(join(dir, 'clip.mp4'), video);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('takes the subtitles next to a video as its telemetry', async () => {
    expect(await findDjiSubtitles(join(dir, 'DJI_0001.MP4'))).toBe(join(dir, 'DJI_0001.SRT'));
    const loaded = await loadVideo(join(dir, 'DJI_0001.MP4'));
    expect(loaded.telemetry?.kind).toBe('dji');
    expect(loaded.telemetry && getChannel(loaded.telemetry, 'latitude')?.values[0]).toBe(59.3294);
    // Any other video still loads, without telemetry.
    expect((await loadVideo(join(dir, 'clip.mp4'))).telemetry).toBeNull();
  });

  it('loads subtitles as a data source, alone or through their video', async () => {
    expect(detectSourceKind('DJI_0001.SRT')).toBe('dji');
    expect((await loadSourceFile(join(dir, 'DJI_0001.SRT'))).kind).toBe('dji');
    expect((await loadSourceFile(join(dir, 'DJI_0001.MP4'), 'gopro')).kind).toBe('dji');
    await expect(loadSourceFile(join(dir, 'clip.mp4'), 'gopro')).rejects.toThrow(/no telemetry/);
  });

  it('feeds the values: GPS by kind, speed and position', async () => {
    const loaded = await loadVideo(join(dir, 'DJI_0001.MP4'));
    const { project, video } = addVideo(createProject(), {
      path: join(dir, 'DJI_0001.MP4'),
      info: loaded.info,
      hasTelemetry: true,
      telemetryKind: loaded.telemetry?.kind,
    });
    expect(project.sources[0]?.kind).toBe('dji');
    const engine = createValueEngine(
      project,
      { videos: { [video.id]: loaded.info }, series: { [`${video.id}-telemetry`]: loaded.telemetry! } },
      { frameRate: 30 },
    );
    expect(engine.has('dji.latitude')).toBe(true);
    expect(engine.get('latitude')[0]).toBe(59.3294);
    expect(engine.list().find((v) => v.id === 'latitude')?.description).toContain('DJI telemetry');
    expect(Number.isFinite(engine.get('speed.kmh')[0])).toBe(true);
  });
});
