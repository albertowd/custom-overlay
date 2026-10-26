import { describe, expect, it } from 'vitest';
import {
  autoSync,
  correlateChannels,
  type PlacedSubject,
  type SyncSubject,
  toItemTime,
  toTimelineTime,
} from '../src/sync/sync.js';
import { speedChannel } from './helpers/fixtures.js';

/** Subject recording the session profile from `start` for `duration` seconds. */
function subject(start: number, duration: number, epochMs: number | null, extra: Partial<SyncSubject> = {}) {
  return {
    label: `@${start}`,
    startEpochMs: epochMs,
    range: { start: 0, end: duration },
    speed: speedChannel(start, duration, 10),
    ...extra,
  } satisfies SyncSubject;
}

function placed(s: SyncSubject, offsetSeconds = 0): PlacedSubject {
  return { ...s, offsetSeconds };
}

describe('time conversion', () => {
  it('round trips', () => {
    expect(toItemTime(toTimelineTime(12.5, 3.25), 3.25)).toBe(12.5);
  });
});

describe('correlateChannels', () => {
  it('finds a logger started before the video', () => {
    // Video covers session time 100..220; the logger recorded 0..400.
    const match = correlateChannels(speedChannel(100, 120, 18), speedChannel(0, 400, 25));
    expect(match?.offset).toBeCloseTo(-100, 1);
    expect(match?.r).toBeGreaterThan(0.95);
    expect(match?.ambiguous).toBe(false);
  });

  it('finds a logger started after the video', () => {
    expect(correlateChannels(speedChannel(0, 200, 18), speedChannel(40, 120, 10))?.offset).toBeCloseTo(40, 1);
  });

  it('flags repeating patterns as ambiguous', () => {
    const lap = (t: number) => 30 + 10 * Math.sin((2 * Math.PI * t) / 60);
    const match = correlateChannels(speedChannel(0, 300, 10, lap), speedChannel(130, 90, 10, lap));
    expect(match?.ambiguous).toBe(true);
  });

  it('needs samples', () => {
    const empty = { ...speedChannel(0, 0, 10) };
    expect(correlateChannels(empty, speedChannel(0, 10, 10))).toBeNull();
  });
});

describe('autoSync', () => {
  const T0 = 1_700_000_000_000;

  it('aligns by GPS time and refines with the speed signal', () => {
    // Logger clock is 0.7 s ahead of the GoPro one.
    const results = autoSync({
      placed: [placed(subject(100, 120, T0))],
      target: subject(0, 400, T0 - 100_000 + 700),
    });
    expect(results.map((r) => r.method)).toEqual(['correlation', 'timestamp']);
    expect(results[0]?.offsetSeconds).toBeCloseTo(-100, 1);
    expect(results[1]?.offsetSeconds).toBeCloseTo(-99.3, 3);
  });

  it('places relative to an offset subject', () => {
    const results = autoSync({
      placed: [placed(subject(0, 60, null)), placed(subject(60, 60, T0), 60)],
      target: subject(90, 30, T0 + 30_000),
    });
    const timestamp = results.find((r) => r.method === 'timestamp');
    expect(timestamp?.offsetSeconds).toBe(90);
    expect(results[0]?.offsetSeconds).toBeCloseTo(90, 1);
  });

  it('compares camera clocks of two videos directly', () => {
    const clock = (epochMs: number) => [{ source: 'mvhd', epochMs }];
    const results = autoSync({
      placed: [placed(subject(0, 60, null, { clock: clock(T0), speed: undefined }))],
      target: subject(30, 60, null, { clock: clock(T0 + 30_000), speed: undefined }),
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ method: 'camera-clock', offsetSeconds: 30, confidence: 0.6 });
  });

  it('converts camera clocks with the local timezone first, then UTC', () => {
    // Camera at UTC-3: local 10:00 is 13:00 UTC; the logger started at 12:55 UTC.
    const local = Date.UTC(2024, 4, 1, 10);
    const results = autoSync({
      placed: [
        placed(subject(0, 600, null, { clock: [{ source: 'mvhd', epochMs: local }], speed: undefined })),
      ],
      target: subject(0, 900, Date.UTC(2024, 4, 1, 12, 55), { speed: undefined }),
      timezoneOffsetMinutes: -180,
    });
    expect(results[0]).toMatchObject({ method: 'camera-clock', offsetSeconds: -300 });
    expect(results[0]?.message).toContain('UTC-03:00');
    expect(results[0]).toMatchObject({ code: 'placedClockAsZone', params: { zone: 'UTC-03:00' } });
    expect(results[1]?.notes).toContain('farFromTimeline');
    // The UTC reading lands 3 hours away from the video: implausible.
    expect(results[1]?.confidence).toBeLessThanOrEqual(0.1);
  });

  it('includes caller candidates and needs something placed', () => {
    const extra = [
      {
        method: 'chapter' as const,
        offsetSeconds: 60,
        confidence: 0.95,
        code: 'chapterContinues' as const,
        params: {},
        message: 'chapter',
      },
    ];
    const results = autoSync({
      placed: [placed(subject(0, 60, null))],
      target: subject(60, 60, null),
      extra,
    });
    expect(results[0]?.method).toBe('chapter');
    expect(autoSync({ placed: [], target: subject(0, 1, null) })).toEqual([]);
  });
});
