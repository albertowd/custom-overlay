import { describe, expect, it } from 'vitest';
import { rgbaToYuva420p, yuva420pSize } from '../src/export/yuv.js';

const BT709_TV = { matrix: 'bt709', range: 'tv' } as const;

/** A width × height frame of one premultiplied RGBA colour. */
function solid(width: number, height: number, [r, g, b, a]: number[]): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < out.length; i += 4) out.set([r, g, b, a] as number[], i);
  return out;
}

/** The Y, U, V and A planes of a `yuva420p` frame. */
function planes(frame: Uint8Array, width: number, height: number) {
  const luma = width * height;
  const chroma = luma / 4;
  return {
    y: frame.subarray(0, luma),
    u: frame.subarray(luma, luma + chroma),
    v: frame.subarray(luma + chroma, luma + 2 * chroma),
    a: frame.subarray(luma + 2 * chroma),
  };
}

describe('widget frames as yuva420p', () => {
  it('sizes the planes', () => {
    expect(yuva420pSize(3840, 2160)).toBe(20_736_000);
  });

  it('converts colours like ffmpeg (BT.709, limited range)', () => {
    // ffmpeg's scale=out_color_matrix=bt709:out_range=tv gives 121 96 202 for #ff5a36.
    const orange = planes(rgbaToYuva420p(solid(2, 2, [255, 90, 54, 255]), 2, 2, BT709_TV), 2, 2);
    expect([orange.y[0], orange.u[0], orange.v[0], orange.a[0]]).toEqual([121, 96, 202, 255]);
    const white = planes(rgbaToYuva420p(solid(2, 2, [255, 255, 255, 255]), 2, 2, BT709_TV), 2, 2);
    expect([white.y[0], white.u[0], white.v[0]]).toEqual([235, 128, 128]);
    const full = planes(
      rgbaToYuva420p(solid(2, 2, [255, 255, 255, 255]), 2, 2, { matrix: 'bt709', range: 'pc' }),
      2,
      2,
    );
    expect(full.y[0]).toBe(255);
  });

  it('leaves transparent pixels transparent, black and neutral', () => {
    const frame = planes(rgbaToYuva420p(new Uint8Array(4 * 4 * 4), 4, 4, BT709_TV), 4, 4);
    expect([...frame.a]).toEqual(new Array(16).fill(0));
    expect([...frame.y]).toEqual(new Array(16).fill(16));
    expect([...frame.u, ...frame.v]).toEqual(new Array(8).fill(128));
  });

  it('takes straight colour from premultiplied pixels', () => {
    // Half transparent orange, premultiplied: the colour is the opaque one's.
    const half = planes(rgbaToYuva420p(solid(2, 2, [128, 45, 27, 128]), 2, 2, BT709_TV), 2, 2);
    expect(half.a[0]).toBe(128);
    expect(Math.abs((half.y[0] as number) - 121)).toBeLessThanOrEqual(1);
    const straight = planes(
      rgbaToYuva420p(solid(2, 2, [255, 90, 54, 128]), 2, 2, BT709_TV, 'straight'),
      2,
      2,
    );
    expect([straight.y[0], straight.u[0], straight.v[0], straight.a[0]]).toEqual([121, 96, 202, 128]);
  });

  it('keeps the colour of a thin edge next to transparent pixels', () => {
    // One orange pixel in a 2 × 2 block: its chroma, not a quarter of it.
    const rgba = new Uint8Array(2 * 2 * 4);
    rgba.set([255, 90, 54, 255], 0);
    const edge = planes(rgbaToYuva420p(rgba, 2, 2, BT709_TV), 2, 2);
    expect([edge.u[0], edge.v[0]]).toEqual([96, 202]);
    expect([...edge.a]).toEqual([255, 0, 0, 0]);
  });

  it('refuses odd sizes', () => {
    expect(() => rgbaToYuva420p(new Uint8Array(3 * 2 * 4), 3, 2, BT709_TV)).toThrow(/even/);
  });
});
