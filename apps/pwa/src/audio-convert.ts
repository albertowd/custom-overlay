/**
 * Audio of the browser's video export: every piece converted to one format (the encoder takes no
 * other), 48 kHz stereo like the desktop export.
 */

export const SAMPLE_RATE = 48_000;

/** Stereo planes: mono is doubled, channels past the second are left out. */
export function toStereo(planes: readonly Float32Array[]): [Float32Array, Float32Array] {
  const left = planes[0] ?? new Float32Array(0);
  return [left, planes[1] ?? left];
}

/**
 * Linear resampling of a stream of stereo chunks to 48 kHz. Positions count input frames from the
 * start of the stream, and the last frame of a chunk is kept for the next one, so a stream cut in
 * chunks sounds like one piece.
 */
export class StereoResampler {
  /** Input position (frames from the stream start) of the next output frame. */
  private next = 0;
  /** Input frame index of the first frame of the next chunk. */
  private base = 0;
  /** Last frame of the previous chunk (input frame `base - 1`). */
  private last: [number, number] = [0, 0];
  private readonly step: number;

  constructor(readonly inputRate: number) {
    this.step = inputRate / SAMPLE_RATE;
  }

  push(left: Float32Array, right: Float32Array): [Float32Array, Float32Array] {
    if (this.inputRate === SAMPLE_RATE) return [left, right];
    const { base, step } = this;
    const end = base + left.length - 1;
    const count = left.length === 0 ? 0 : Math.max(0, Math.floor((end - this.next) / step) + 1);
    const outLeft = new Float32Array(count);
    const outRight = new Float32Array(count);
    const sample = (plane: Float32Array, side: 0 | 1, i: number) =>
      i < base ? this.last[side] : (plane[i - base] as number);
    for (let j = 0; j < count; j++) {
      const position = this.next + j * step;
      const i = Math.floor(position);
      const f = position - i;
      // Past the last frame only when exactly on it (f = 0).
      const k = Math.min(i + 1, end);
      outLeft[j] = sample(left, 0, i) * (1 - f) + sample(left, 0, k) * f;
      outRight[j] = sample(right, 1, i) * (1 - f) + sample(right, 1, k) * f;
    }
    this.next += count * step;
    if (left.length > 0) this.last = [left[left.length - 1] as number, right[right.length - 1] as number];
    this.base = end + 1;
    return [outLeft, outRight];
  }
}

/** Both planes back to back, as `f32-planar` audio data. */
export function planar(left: Float32Array, right: Float32Array): Float32Array {
  const data = new Float32Array(left.length * 2);
  data.set(left, 0);
  data.set(right, left.length);
  return data;
}
