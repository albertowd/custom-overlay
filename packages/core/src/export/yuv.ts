/**
 * Widget frames as planar YUV with alpha, converted where they are drawn (the export threads) so
 * ffmpeg only has to upload them to the GPU: converting 4K RGBA in ffmpeg costs more CPU than
 * the rest of a GPU export.
 */

export interface YuvConversion {
  /** Matrix of the output video. */
  matrix: 'bt709' | 'bt2020';
  /** Range of the output video: limited (`tv`) or full (`pc`). */
  range: 'tv' | 'pc';
}

/** How RGBA pixels store colour: multiplied by alpha (Skia's buffer) or not (`getImageData`). */
export type AlphaMode = 'premultiplied' | 'straight';

/** Bytes of a `yuva420p` frame: full size luma and alpha, quarter size chroma. */
export function yuva420pSize(width: number, height: number): number {
  return width * height * 2 + (width / 2) * (height / 2) * 2;
}

const COEFFICIENTS = {
  bt709: { kr: 0.2126, kb: 0.0722 },
  bt2020: { kr: 0.2627, kb: 0.0593 },
} as const;

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * Converts RGBA to straight alpha `yuva420p`: planes Y, U, V, A in ffmpeg's order. Width and
 * height must be even. Chroma is averaged over each 2 × 2 block weighted by alpha, so a thin edge
 * keeps its colour instead of fading toward the grey of the transparent pixels next to it.
 * Transparent blocks (all bytes 0) are skipped, which is most of a frame.
 */
export function rgbaToYuva420p(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  conversion: YuvConversion,
  alpha: AlphaMode = 'premultiplied',
  out: Uint8Array = new Uint8Array(yuva420pSize(width, height)),
): Uint8Array {
  const premultiplied = alpha === 'premultiplied';
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error('yuva420p needs an even width and height');
  if (rgba.byteLength < width * height * 4) throw new Error('Not enough RGBA pixels');
  const { kr, kb } = COEFFICIENTS[conversion.matrix];
  const kg = 1 - kr - kb;
  const full = conversion.range === 'pc';
  const yScale = full ? 1 : 219 / 255;
  const yOffset = full ? 0 : 16;
  const cScale = full ? 1 : 224 / 255;
  const cb = cScale / (2 * (1 - kb));
  const cr = cScale / (2 * (1 - kr));

  const lumaSize = width * height;
  const chromaWidth = width / 2;
  const chromaSize = chromaWidth * (height / 2);
  const uStart = lumaSize;
  const vStart = uStart + chromaSize;
  const aStart = vStart + chromaSize;
  // Transparent everywhere first; drawn pixels overwrite it.
  out.fill(yOffset, 0, lumaSize);
  out.fill(128, uStart, aStart);
  out.fill(0, aStart, aStart + lumaSize);

  // Whole pixels as 32-bit words: a transparent premultiplied pixel is 0.
  const words =
    rgba.byteOffset % 4 === 0
      ? new Uint32Array(rgba.buffer, rgba.byteOffset, width * height)
      : new Uint32Array(rgba.slice(0, width * height * 4).buffer);

  for (let y = 0; y < height; y += 2) {
    const row = y * width;
    for (let x = 0; x < width; x += 2) {
      const p = row + x;
      const block =
        (words[p] as number) |
        (words[p + 1] as number) |
        (words[p + width] as number) |
        (words[p + width + 1] as number);
      if (block === 0) continue;
      let sumU = 0;
      let sumV = 0;
      let sumA = 0;
      for (let k = 0; k < 4; k++) {
        const i = k < 2 ? p + k : p + width + k - 2;
        const o = i * 4;
        const a = rgba[o + 3] as number;
        if (a === 0) continue;
        // Straight colour, 0..255.
        const s = premultiplied ? 255 / a : 1;
        const r = Math.min(255, (rgba[o] as number) * s);
        const g = Math.min(255, (rgba[o + 1] as number) * s);
        const b = Math.min(255, (rgba[o + 2] as number) * s);
        const luma = kr * r + kg * g + kb * b;
        out[i] = clamp(yOffset + luma * yScale);
        out[aStart + i] = a;
        sumU += (b - luma) * a;
        sumV += (r - luma) * a;
        sumA += a;
      }
      if (sumA > 0) {
        const c = (y / 2) * chromaWidth + x / 2;
        out[uStart + c] = clamp(128 + (sumU / sumA) * cb);
        out[vStart + c] = clamp(128 + (sumV / sumA) * cr);
      }
    }
  }
  return out;
}
