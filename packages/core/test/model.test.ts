import { describe, expect, it } from 'vitest';
import {
  ENCODE_PRESETS,
  encoderForPreset,
  frameRateIn,
  frameSizeFor,
  presetNotes,
  youtubeBitrateMbps,
  youtubePresetFor,
  youtubePresetForOutput,
} from '../src/export/presets.js';
import { goproDevicesToSeries } from '../src/loaders/gopro.js';
import { DEFAULT_PALETTE } from '../src/model/palette.js';
import {
  createProject,
  createTemplate,
  DEFAULT_OUTPUT,
  type OutputSettings,
  parseProject,
  parseTemplate,
  serializeProject,
  ValidationError,
} from '../src/model/project.js';
import {
  type Channel,
  findSampleIndex,
  resampleUniform,
  sampleAt,
  summarizeSeries,
} from '../src/model/telemetry.js';
import { WidgetSchema } from '../src/model/widget.js';

const channel: Channel = {
  key: 'speed',
  label: 'Speed',
  unit: 'm/s',
  time: new Float64Array([0, 1, 2, 10]),
  values: new Float64Array([0, 10, 20, 30]),
};

describe('telemetry helpers', () => {
  it('finds sample indices', () => {
    expect(findSampleIndex(channel.time, -1)).toBe(-1);
    expect(findSampleIndex(channel.time, 0)).toBe(0);
    expect(findSampleIndex(channel.time, 1.5)).toBe(1);
    expect(findSampleIndex(channel.time, 99)).toBe(3);
  });

  it('interpolates, holds and detects gaps', () => {
    expect(sampleAt(channel, 0.5)).toBe(5);
    expect(sampleAt(channel, 0.5, { interpolate: false })).toBe(0);
    expect(sampleAt(channel, 6)).toBeNaN();
    expect(sampleAt(channel, 6, { maxGapSeconds: 10 })).toBe(25);
    expect(sampleAt(channel, 10.5)).toBe(30);
    expect(sampleAt(channel, 12)).toBeNaN();
  });

  it('resamples on a uniform grid', () => {
    expect(Array.from(resampleUniform(channel, 0, 2, 2))).toEqual([0, 5, 10, 15, 20]);
  });

  it('summarizes a series', () => {
    const summary = summarizeSeries({
      kind: 'gopro',
      name: 'x',
      startEpochMs: 0,
      channels: [channel],
      metadata: {},
    });
    expect(summary).toMatchObject({ durationSeconds: 10, startTime: '1970-01-01T00:00:00.000Z' });
    expect(summary.channels[0]).toMatchObject({ samples: 4, min: 0, max: 30, rateHz: 0.3 });
  });
});

describe('project model', () => {
  it('fills defaults', () => {
    const project = createProject({ name: 'Test' });
    expect(project.output).toMatchObject({ width: 1920, height: 1080, frameRate: 60 });
    expect(project.palette.primary).toBe('#ff5a36');
    expect(project.template.antialias).toBe(true);
    expect(project.export.mode).toBe('video');
    expect(parseProject(JSON.parse(serializeProject(project)))).toEqual(project);
  });

  it('reports validation issues', () => {
    expect(() => parseProject({ version: 2 })).toThrow(ValidationError);
    try {
      parseProject({ version: 1, output: { width: -1 } });
    } catch (e) {
      expect((e as ValidationError).issues[0]).toMatch(/^output\.width/);
    }
  });

  it('creates templates with defaults', () => {
    expect(createTemplate().name).toBe('Untitled template');
    expect(parseTemplate({ version: 1 }).widgets).toEqual([]);
  });
});

describe('GoPro telemetry conversion', () => {
  it('normalizes GPS and IMU streams', () => {
    const series = goproDevicesToSeries(
      {
        '1': {
          'device name': 'HERO12 Black',
          streams: {
            GPS9: {
              samples: [
                { cts: 0, date: new Date(5_000), value: [1, 2, 3, 4, 5, 0, 0, 0, 3] },
                { cts: 100, date: new Date(5_100), value: [1.1, 2.1, 3, 4.5, 5, 0, 0, 0, 3] },
              ],
            },
            ACCL: {
              name: 'Accelerometer (up/down, right/left, forward/back)',
              samples: [{ cts: 0, value: [9.80665, 0, -9.80665] }],
            },
            GYRO: { name: 'Gyroscope (z,x,y)', samples: [{ cts: 0, value: [1, 2, 3] }] },
          },
        },
      },
      'GX01.MP4',
    );
    expect(series?.startEpochMs).toBe(5_000);
    expect(series?.metadata.device).toBe('HERO12 Black');
    const keys = series?.channels.map((c) => c.key);
    expect(keys).toEqual([
      'latitude',
      'longitude',
      'altitude',
      'speed',
      'speed3d',
      'accelVertical',
      'accelLateral',
      'accelLongitudinal',
      'gyroZ',
      'gyroX',
      'gyroY',
    ]);
    expect(series?.channels[3]?.time[1]).toBeCloseTo(0.1, 6);
    expect(series?.channels[5]?.values[0]).toBeCloseTo(1, 6);
    expect(series?.channels[7]?.values[0]).toBeCloseTo(-1, 6);
  });

  it('returns null without usable streams', () => {
    expect(goproDevicesToSeries({ '1': { streams: {} } }, 'x')).toBeNull();
  });
});

describe('encode presets', () => {
  const output = (overrides: Partial<OutputSettings>): OutputSettings => ({
    ...DEFAULT_OUTPUT,
    ...overrides,
  });

  it('follows the YouTube bitrate table', () => {
    expect(youtubeBitrateMbps(output({}))).toBe(12);
    expect(youtubeBitrateMbps(output({ frameRate: 30 }))).toBe(8);
    expect(youtubeBitrateMbps(output({ width: 1080, height: 1920 }))).toBe(12);
    const hlg = output({
      width: 3840,
      height: 2160,
      color: { space: 'rec2020-hlg', range: 'limited', bitDepth: 10 },
    });
    expect(youtubeBitrateMbps(hlg)).toBe(85);
    // The SDR table on demand, and the HDR table for an SDR output.
    expect(youtubeBitrateMbps(hlg, false)).toBe(68);
    expect(youtubeBitrateMbps(output({}), true)).toBe(15);
  });

  it('splits YouTube by codec, resolution and frame rate, at the top of each range', () => {
    const hlg = output({
      width: 3840,
      height: 2160,
      color: { space: 'rec2020-hlg', range: 'limited', bitDepth: 10 },
    });
    expect(encoderForPreset('youtube-sdr-h264-1080p30', output({}))).toMatchObject({
      codec: 'h264',
      bitrateMbps: 8,
      keyframeIntervalSeconds: 0.5,
      bFrames: 2,
      audio: 'aac',
      audioBitrateKbps: 384,
    });
    // The bitrate is the preset's cell, whatever the output.
    expect(encoderForPreset('youtube-sdr-h264-2160p60', output({}))).toMatchObject({ bitrateMbps: 68 });
    expect(encoderForPreset('youtube-sdr-h264-4320p60', output({}))).toMatchObject({ bitrateMbps: 240 });
    expect(encoderForPreset('youtube-sdr-hevc-2160p30', hlg)).toMatchObject({
      codec: 'hevc',
      bitrateMbps: 45,
    });
    expect(encoderForPreset('youtube-hdr-hevc-2160p30', hlg)).toMatchObject({
      codec: 'hevc',
      bitrateMbps: 56,
    });
    expect(encoderForPreset('youtube-hdr-av1-720p60', hlg)).toMatchObject({ codec: 'av1', bitrateMbps: 9.5 });
    expect(youtubePresetFor(hlg)).toBe('youtube-hdr-hevc-2160p60');
    const gopro = output({
      width: 2704,
      height: 1520,
      frameRate: 25,
      color: { space: 'rec709', range: 'full', bitDepth: 10 },
    });
    expect(youtubePresetFor(gopro)).toBe('youtube-sdr-hevc-1440p30');
    expect(youtubePresetFor(output({}))).toBe('youtube-sdr-h264-1080p60');
    // 7 SDR rows and 5 HDR rows, two frame rate columns each.
    expect(ENCODE_PRESETS.filter((p) => p.youtube?.family.hdr === false)).toHaveLength(28);
    expect(ENCODE_PRESETS.filter((p) => p.youtube?.family.hdr)).toHaveLength(20);
  });

  it('maps outputs to the cells of the YouTube tables', () => {
    expect(frameRateIn(119.88, 'high')).toBe(59.94);
    expect(frameRateIn(119.88, 'standard')).toBe(29.97);
    expect(frameRateIn(240, 'high')).toBe(60);
    expect(frameRateIn(50, 'standard')).toBe(25);
    expect(frameRateIn(24, 'high')).toBe(48);
    expect(frameRateIn(23.976, 'standard')).toBe(23.976);
    // The 16:9 sizes YouTube lists, else the aspect ratio kept; portrait stays portrait.
    expect(frameSizeFor(1440, output({ width: 2704, height: 1520 }))).toEqual({ width: 2560, height: 1440 });
    expect(frameSizeFor(480, output({}))).toEqual({ width: 854, height: 480 });
    expect(frameSizeFor(1080, output({ width: 4000, height: 3000 }))).toEqual({ width: 1440, height: 1080 });
    expect(frameSizeFor(2160, output({ width: 1080, height: 1920 }))).toEqual({ width: 2160, height: 3840 });
    // Same codec, nearest row (HDR has none under 720p) and the output's column; others unchanged.
    expect(youtubePresetForOutput('youtube-sdr-h264-1080p60', output({ width: 854, height: 480 }))).toBe(
      'youtube-sdr-h264-480p60',
    );
    const small = output({ width: 640, height: 360, frameRate: 30 });
    expect(youtubePresetForOutput('youtube-hdr-av1-1080p60', small)).toBe('youtube-hdr-av1-720p30');
    expect(youtubePresetForOutput('archive', output({ frameRate: 30 }))).toBe('archive');
  });

  it('migrates the preset of projects saved by earlier versions', () => {
    const saved = serializeProject(createProject({ output: output({ frameRate: 30 }) }));
    const legacy = JSON.parse(saved.replace('"youtube-sdr-h264-1080p60"', '"youtube"'));
    expect(parseProject(legacy).export.encoder).toMatchObject({
      preset: 'youtube-sdr-h264-1080p30',
      bitrateMbps: 8,
    });
    const custom = JSON.parse(saved.replace('"youtube-sdr-h264-1080p60"', '"custom"'));
    expect(parseProject(custom).export.encoder.preset).toBe('custom');
  });

  it('maps the preset ids of earlier versions', () => {
    expect(encoderForPreset('youtube', output({ frameRate: 30 })).preset).toBe('youtube-sdr-h264-1080p30');
    expect(encoderForPreset('youtube-hevc', output({ width: 3840, height: 2160 })).preset).toBe(
      'youtube-sdr-hevc-2160p60',
    );
    expect(encoderForPreset('youtube-hdr', output({})).preset).toBe('youtube-hdr-hevc-1080p60');
    expect(encoderForPreset('youtube-hdr-av1-30', output({ frameRate: 24 })).preset).toBe(
      'youtube-hdr-av1-1080p30',
    );
  });

  it('notes output formats a preset does not suit', () => {
    const fullTenBit = output({ color: { space: 'rec709', range: 'full', bitDepth: 10 } });
    expect(presetNotes('youtube-sdr-h264-1080p60', output({}))).toEqual([]);
    expect(presetNotes('youtube-sdr-h264-1080p60', fullTenBit)).toEqual(['sdrConverted', 'h264TenBit']);
    expect(
      presetNotes('youtube-hdr-hevc-720p30', output({ width: 854, height: 480, frameRate: 30 })),
    ).toEqual(['hdrNeedsHdrOutput', 'hdrResolution']);
    expect(presetNotes('youtube-sdr-hevc-1080p60', output({ frameRate: 119.88 }))).toEqual(['frameRate']);
    expect(
      presetNotes('archive', output({ color: { space: 'rec2020', range: 'full', bitDepth: 8 } })),
    ).toEqual([]);
  });

  it('offers other presets and falls back to YouTube', () => {
    expect(ENCODE_PRESETS.slice(0, 2).map((p) => p.id)).toEqual([
      'youtube-sdr-h264-4320p30',
      'youtube-sdr-h264-4320p60',
    ]);
    expect(ENCODE_PRESETS.slice(-2).map((p) => p.id)).toEqual(['archive', 'editing']);
    expect(encoderForPreset('archive', output({}))).toMatchObject({ codec: 'hevc', bitrateMbps: 24 });
    expect(encoderForPreset('nope', output({})).preset).toBe('youtube-sdr-h264-1080p60');
  });
});

describe('widget colour overrides', () => {
  const widget = (colors: unknown) => WidgetSchema.parse({ id: 'w', type: 'text', colors });

  it('keeps only the colours a widget overrides', () => {
    expect(widget({}).colors).toEqual({});
    expect(WidgetSchema.parse({ id: 'w', type: 'text' }).colors).toEqual({});
    expect(widget({ primary: '#ff0000' }).colors).toEqual({ primary: '#ff0000' });
  });

  it('drops a copy of the whole default palette saved by earlier versions', () => {
    expect(widget({ ...DEFAULT_PALETTE }).colors).toEqual({});
    // A real full override with one changed colour stays.
    expect(widget({ ...DEFAULT_PALETTE, primary: '#d0302a' }).colors.primary).toBe('#d0302a');
  });
});
