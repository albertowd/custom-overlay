import type { ExportSegment, VideoFit } from '@custom-overlay/core';
import { describe, expect, it } from 'vitest';
import { planar, SAMPLE_RATE, StereoResampler, toStereo } from '../../src/audio-convert';
import {
  backdropBlur,
  backdropPlacement,
  backdropSize,
  displaySize,
  drawPlaced,
  framePlacement,
  pieceFrames,
} from '../../src/video-compose';

const video = (from: number, duration: number): ExportSegment =>
  ({ kind: 'video', video: { id: 'v' }, info: {}, from, duration }) as unknown as ExportSegment;
const gap = (duration: number): ExportSegment => ({ kind: 'gap', duration });

const fit = (overrides: Partial<VideoFit> = {}): VideoFit => ({
  mode: 'contain',
  rotation: 0,
  rotateWidgets: false,
  zoom: 1,
  x: 0.5,
  y: 0.5,
  ...overrides,
});

describe('pieces and frames', () => {
  it('gives each frame to the piece covering its instant, with the video time it shows', () => {
    // 2 s of video from 1 s, half a second of gap, 1.5 s of video: 120 frames at 30 fps.
    const pieces = pieceFrames([video(1, 2), gap(0.5), video(0, 1.5)], 120, 30);
    expect(pieces.map((p) => [p.first, p.count])).toEqual([
      [0, 60],
      [60, 15],
      [75, 45],
    ]);
    expect(pieces[0]?.times[0]).toBe(1);
    expect(pieces[0]?.times[59]).toBeCloseTo(1 + 59 / 30, 9);
    expect(pieces[1]?.times).toEqual([]);
    expect(pieces[2]?.times[0]).toBeCloseTo(0, 9);
  });

  it('keeps every frame when the pieces end a little early, and skips pieces between two frames', () => {
    // A gap between the frames at 1 s and 1.033 s gets none.
    const pieces = pieceFrames([video(0, 1.001), gap(0.01), video(5, 0.45)], 45, 30);
    expect(pieces.map((p) => p.segment.kind)).toEqual(['video', 'video']);
    // The pieces end at 1.461 s, before the last frame (1.467 s): it still goes to the last one.
    expect(pieces.reduce((sum, p) => sum + p.count, 0)).toBe(45);
    expect(pieces[1]?.times.at(-1)).toBeCloseTo(5 + 44 / 30 - 1.011, 9);
    expect(pieceFrames([], 0, 30)).toEqual([]);
  });
});

describe('placement', () => {
  const canvas = { width: 1920, height: 1080 };

  it('fits the video like the desktop export', () => {
    expect(framePlacement({ width: 1280, height: 720 }, 0, canvas, fit())).toEqual({
      cx: 960,
      cy: 540,
      rotation: 0,
      width: 1920,
      height: 1080,
    });
    // A 4:3 video contained in 16:9: pillarboxed.
    expect(framePlacement({ width: 640, height: 480 }, 0, canvas, fit())).toMatchObject({
      width: 1440,
      height: 1080,
    });
    // Zoomed and moved to the left.
    expect(framePlacement({ width: 640, height: 480 }, 0, canvas, fit({ zoom: 2, x: 0 }))).toMatchObject({
      cx: 1440,
      width: 2880,
    });
  });

  it('turns videos by their rotation metadata and by the fit', () => {
    expect(displaySize({ width: 640, height: 480 }, 90)).toEqual({ width: 480, height: 640 });
    expect(displaySize({ width: 640, height: 480 }, 180)).toEqual({ width: 640, height: 480 });
    // Portrait as it plays: 810 x 1080 on screen, drawn turned with its decoded shape.
    expect(framePlacement({ width: 640, height: 480 }, 90, canvas, fit())).toEqual({
      cx: 960,
      cy: 540,
      rotation: 90,
      width: 1080,
      height: 810,
    });
    // A 16:9 video turned onto a vertical canvas fills it.
    expect(
      framePlacement({ width: 1920, height: 1080 }, 0, { width: 1080, height: 1920 }, fit({ rotation: 90 })),
    ).toEqual({
      cx: 540,
      cy: 960,
      rotation: 90,
      width: 1920,
      height: 1080,
    });
    expect(framePlacement({ width: 1920, height: 1080 }, 270, canvas, fit({ rotation: 90 })).rotation).toBe(
      0,
    );
  });

  it('covers the small background canvas, blurred like the desktop export', () => {
    const small = backdropSize(canvas);
    expect(small).toEqual({ width: 240, height: 135 });
    expect(backdropSize({ width: 8, height: 8 })).toEqual({ width: 2, height: 2 });
    // A 4:3 video covers it: wider than the canvas, cropped above and below.
    expect(backdropPlacement({ width: 640, height: 480 }, 0, small, fit())).toMatchObject({
      width: 240,
      height: 180,
    });
    // Radius 11 box blur twice.
    expect(backdropBlur(small)).toBeCloseTo(Math.sqrt(88), 9);
    expect(backdropBlur({ width: 4, height: 4 })).toBeCloseTo(Math.sqrt(4 / 3), 9);
  });

  it('draws an image around its centre', () => {
    const calls: unknown[][] = [];
    const ctx = new Proxy(
      {},
      {
        get:
          (_, key) =>
          (...args: unknown[]) =>
            calls.push([key, ...args]),
      },
    ) as unknown as OffscreenCanvasRenderingContext2D;
    const image = {} as CanvasImageSource;
    drawPlaced(ctx, image, { cx: 100, cy: 50, rotation: 90, width: 40, height: 20 });
    expect(calls).toEqual([
      ['save'],
      ['translate', 100, 50],
      ['rotate', Math.PI / 2],
      ['drawImage', image, -20, -10, 40, 20],
      ['restore'],
    ]);
    calls.length = 0;
    drawPlaced(ctx, image, { cx: 0, cy: 0, rotation: 0, width: 2, height: 2 });
    expect(calls.map(([key]) => key)).toEqual(['save', 'translate', 'drawImage', 'restore']);
  });
});

describe('audio conversion', () => {
  it('makes stereo from mono and keeps the first two channels', () => {
    const left = Float32Array.of(1, 2);
    const right = Float32Array.of(3, 4);
    expect(toStereo([left])).toEqual([left, left]);
    expect(toStereo([left, right, Float32Array.of(9, 9)])).toEqual([left, right]);
    expect(toStereo([])[0]).toHaveLength(0);
    expect(planar(left, right)).toEqual(Float32Array.of(1, 2, 3, 4));
  });

  it('leaves 48 kHz audio alone', () => {
    const plane = Float32Array.of(0.5, 0.25);
    const [left] = new StereoResampler(SAMPLE_RATE).push(plane, plane);
    expect(left).toBe(plane);
  });

  it('resamples a ramp the same whether it comes in one piece or in chunks', () => {
    const rate = 44_100;
    const ramp = Float32Array.from({ length: 4410 }, (_, i) => i / rate);
    const whole = new StereoResampler(rate).push(ramp, ramp)[0];
    const chunked = new StereoResampler(rate);
    const parts: number[] = [];
    for (let at = 0; at < ramp.length; at += 1000) {
      const piece = ramp.subarray(at, at + 1000);
      parts.push(...chunked.push(piece, piece)[0]);
    }
    expect(parts.length).toBe(whole.length);
    // 0.1 s of input: the 4800th output frame falls after the last input frame, in the next chunk.
    expect(whole.length).toBe(4799);
    for (let j = 0; j < whole.length; j++) {
      // A ramp of time stays a ramp of time.
      expect(whole[j]).toBeCloseTo(j / SAMPLE_RATE, 6);
      expect(parts[j]).toBeCloseTo(whole[j] as number, 6);
    }
    expect(chunked.push(new Float32Array(0), new Float32Array(0))[0]).toHaveLength(0);
  });

  it('upsamples too', () => {
    const resampler = new StereoResampler(24_000);
    const [left, right] = resampler.push(Float32Array.of(0, 1, 2), Float32Array.of(0, -1, -2));
    expect([...left]).toEqual([0, 0.5, 1, 1.5, 2]);
    expect([...right]).toEqual([0, -0.5, -1, -1.5, -2]);
    // The next chunk continues between the last frame and its first.
    expect([...resampler.push(Float32Array.of(4), Float32Array.of(4))[0]]).toEqual([3, 4]);
  });
});
