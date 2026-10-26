import type { ItemSyncOutcome, SeriesSummary, StepStatus, SyncResult, VideoInfo } from '@custom-overlay/core';
import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatColor,
  formatDuration,
  formatOutput,
  formatSeries,
  formatSyncOutcome,
  formatSyncResult,
  formatValue,
  formatVideo,
  formatWorkflow,
  table,
} from '../src/format.js';

const video: VideoInfo = {
  path: '/videos/GX010001.MP4',
  fileName: 'GX010001.MP4',
  sizeBytes: 3 * 1024 ** 3,
  durationSeconds: 3725.5,
  width: 3840,
  height: 2160,
  frameRate: 59.94,
  frameCount: 223306,
  codec: 'hvc1',
  creationTime: null,
  hasGpmf: true,
  hasAudio: true,
  color: { space: 'rec2020-hlg', range: 'full', bitDepth: 10 },
  camera: { model: 'HERO11 Black', firmware: 'H22.01.02.32.00' },
  clock: [{ source: 'cdat', epochMs: Date.UTC(2024, 4, 1, 10, 0, 0) }],
};

const syncResult = (confidence: number): SyncResult =>
  ({ method: 'correlation', offsetSeconds: 11.25, confidence, message: 'Speed matched' }) as SyncResult;

describe('formatDuration', () => {
  it('shows minutes and seconds with milliseconds', () => {
    expect(formatDuration(0)).toBe('0:00.000');
    expect(formatDuration(90.5)).toBe('1:30.500');
  });

  it('adds hours and a sign when needed', () => {
    expect(formatDuration(3725.5)).toBe('1:02:05.500');
    expect(formatDuration(-62.25)).toBe('-1:02.250');
  });

  it('shows a dash for values that are not finite', () => {
    expect(formatDuration(Number.NaN)).toBe('-');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('-');
  });
});

describe('formatBytes', () => {
  it('picks the largest unit below 1024', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });

  it('stops at terabytes', () => {
    expect(formatBytes(2048 * 1024 ** 4)).toBe('2048.0 TB');
  });
});

describe('table', () => {
  it('aligns columns to the widest cell and trims line ends', () => {
    expect(
      table(
        ['key', 'value'],
        [
          ['a', '1'],
          ['longer', ''],
        ],
      ),
    ).toBe(['key     value', '------  -----', 'a       1', 'longer'].join('\n'));
  });

  it('treats missing cells as empty', () => {
    expect(table(['a', 'b'], [['x']])).toBe(['a  b', '-  -', 'x'].join('\n'));
  });
});

describe('formatColor / formatOutput', () => {
  it('names the color space, range and bit depth', () => {
    expect(formatColor({ space: 'rec2020-pq', range: 'limited', bitDepth: 10 })).toBe(
      'Rec.2020 PQ, limited range, 10-bit',
    );
  });

  it('describes the output size, rate and color', () => {
    expect(
      formatOutput({
        width: 1920,
        height: 1080,
        frameRate: 30,
        color: { space: 'rec709', range: 'full', bitDepth: 8 },
      } as Parameters<typeof formatOutput>[0]),
    ).toBe('1920x1080 @ 30 fps, Rec.709, full range, 8-bit');
  });
});

describe('formatVideo', () => {
  it('lists the file, clock and camera details', () => {
    const text = formatVideo(video);
    expect(text).toContain('File:        /videos/GX010001.MP4');
    expect(text).toContain('Size:        3.0 GB');
    expect(text).toContain('Duration:    1:02:05.500');
    expect(text).toContain('Resolution:  3840x2160 @ 59.94 fps (223306 frames)');
    expect(text).toContain('Color:       Rec.2020 HLG, full range, 10-bit');
    expect(text).toContain('Clock:       cdat 2024-05-01T10:00:00 (camera, no timezone)');
    expect(text).toContain('Camera:      HERO11 Black, firmware H22.01.02.32.00');
    expect(text).toContain('Telemetry:   GoPro GPMF track');
  });

  it('shows dashes for a video without clock, camera or telemetry', () => {
    const text = formatVideo({
      ...video,
      clock: [],
      camera: { model: null, firmware: null },
      hasGpmf: false,
    });
    expect(text).toContain('Clock:       - (camera, no timezone)');
    expect(text).toContain('Camera:      -');
    expect(text).toContain('Telemetry:   none');
  });

  it('shows the model alone without firmware', () => {
    expect(formatVideo({ ...video, camera: { model: 'HERO7', firmware: null } })).toContain(
      'Camera:      HERO7\n',
    );
  });
});

describe('formatSeries', () => {
  const summary = {
    name: 'session.csv',
    kind: 'racechrono',
    startTime: null,
    durationSeconds: 65,
    channels: [
      { key: 'speed', label: 'Speed', unit: 'm/s', samples: 650, rateHz: 10, min: 0.123456, max: 42 },
      { key: 'distance', label: 'Distance', unit: 'm', samples: 650, rateHz: 10, min: 0, max: 12345.6 },
      { key: 'empty', label: 'Empty', unit: '', samples: 0, rateHz: 0, min: Number.NaN, max: Number.NaN },
    ],
  } as unknown as SeriesSummary;

  it('shows the header and a table of channels', () => {
    const lines = formatSeries(summary).split('\n');
    expect(lines[0]).toBe('Source:      session.csv (racechrono)');
    expect(lines[1]).toBe('Start:       unknown (relative times only)');
    expect(lines[2]).toBe('Duration:    1:05.000');
    expect(lines[4]).toMatch(/^key\s+label\s+unit\s+samples\s+Hz\s+min\s+max$/);
  });

  it('rounds to 4 significant digits, whole numbers from 1000, dash for NaN', () => {
    const rows = formatSeries(summary).split('\n').slice(6);
    expect(rows[0]?.split(/\s+/)).toEqual(['speed', 'Speed', 'm/s', '650', '10.0', '0.1235', '42']);
    expect(rows[1]?.split(/\s+/)).toEqual(['distance', 'Distance', 'm', '650', '10.0', '0', '12346']);
    expect(rows[2]?.split(/\s+/)).toEqual(['empty', 'Empty', '0', '0.0', '-', '-']);
  });

  it('shows the absolute start time when known', () => {
    expect(formatSeries({ ...summary, startTime: '2024-05-01T10:00:00.000Z' })).toContain(
      'Start:       2024-05-01T10:00:00.000Z',
    );
  });
});

describe('sync results', () => {
  it('formats the method, offset, confidence and message', () => {
    expect(formatSyncResult(syncResult(0.951))).toBe(
      'correlation  offset 11.250 s  confidence 95%  - Speed matched',
    );
  });

  it('asks for a review below the auto sync confidence', () => {
    const outcome = (confidence: number) =>
      ({ label: 'log.csv', result: syncResult(confidence), candidates: [] }) as unknown as ItemSyncOutcome;
    expect(formatSyncOutcome(outcome(0.99))).toBe(`log.csv: ${formatSyncResult(syncResult(0.99))}`);
    expect(formatSyncOutcome(outcome(0.1))).toBe(
      `log.csv: ${formatSyncResult(syncResult(0.1))} (review in the app)`,
    );
  });

  it('says when an item could not be synced', () => {
    expect(formatSyncOutcome({ label: 'drone.srt', result: null } as unknown as ItemSyncOutcome)).toBe(
      'drone.srt: could not be synced automatically',
    );
  });
});

describe('formatWorkflow', () => {
  it('shows a box per step state and indents its issues', () => {
    const statuses = [
      { title: 'Videos', state: 'complete', issues: [] },
      {
        title: 'Sync',
        state: 'incomplete',
        issues: [
          { severity: 'error', message: 'not synced' },
          { severity: 'warning', message: 'low confidence' },
        ],
      },
      { title: 'Track', state: 'skipped', issues: [] },
      { title: 'Export', state: 'not-applicable', issues: [] },
    ] as unknown as StepStatus[];
    expect(formatWorkflow(statuses).split('\n')).toEqual([
      '[x] Videos (complete)',
      '[ ] Sync (incomplete)',
      '      error: not synced',
      '      warn : low confidence',
      '[-] Track (skipped)',
      '[-] Export (not-applicable)',
    ]);
  });
});

describe('formatValue', () => {
  it('appends the unit when there is one', () => {
    expect(formatValue(72.04, 'km/h')).toBe('72.04 km/h');
    expect(formatValue(3, '')).toBe('3');
  });

  it('shows long durations in seconds as m:ss.mmm', () => {
    expect(formatValue(90.5, 's')).toBe('1:30.500');
    expect(formatValue(-61, 's')).toBe('-1:01.000');
    expect(formatValue(59.5, 's')).toBe('59.5 s');
  });

  it('shows epoch milliseconds as an ISO date', () => {
    expect(formatValue(Date.UTC(2024, 4, 1), 'ms')).toBe('2024-05-01T00:00:00.000Z');
    expect(formatValue(250, 'ms')).toBe('250 ms');
  });

  it('shows a dash for NaN', () => {
    expect(formatValue(Number.NaN, 'm')).toBe('-');
  });
});
