import { describe, expect, it } from 'vitest';
import { MemoryReader } from '../src/io/reader.js';
import { listTopLevelBoxes, Mp4ParseError, parseMp4, readTrackSamples } from '../src/media/mp4.js';
import { extractGpmf, probeVideo } from '../src/media/probe.js';
import { buildMp4 } from './helpers/mp4-builder.js';

// 2024-05-01T10:00:00Z in MP4 epoch seconds
const CREATION = Date.UTC(2024, 4, 1, 10) / 1000 + 2_082_844_800;

function goproLikeFile(): Uint8Array {
  const frames = Array.from({ length: 60 }, (_, i) => new Uint8Array([i, i, i]));
  const gpmf = [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6]), new Uint8Array([7, 8, 9])];
  return buildMp4(
    [
      {
        id: 1,
        handler: 'vide',
        format: 'hvc1',
        timescale: 60000,
        sampleDelta: 1001,
        samples: frames,
        width: 3840,
        height: 2160,
      },
      { id: 2, handler: 'meta', format: 'gpmd', timescale: 1000, sampleDelta: 1001, samples: gpmf },
    ],
    CREATION,
  );
}

describe('mp4 parser', () => {
  it('lists top level boxes', async () => {
    const boxes = await listTopLevelBoxes(new MemoryReader(goproLikeFile()));
    expect(boxes.map((b) => b.type)).toEqual(['ftyp', 'mdat', 'moov']);
  });

  it('parses tracks and creation time', async () => {
    const info = await parseMp4(new MemoryReader(goproLikeFile()));
    expect(info.creationTime?.toISOString()).toBe('2024-05-01T10:00:00.000Z');
    expect(info.tracks).toHaveLength(2);
    const [video, meta] = info.tracks;
    expect(video).toMatchObject({
      handlerType: 'vide',
      format: 'hvc1',
      width: 3840,
      height: 2160,
      sampleCount: 60,
    });
    expect(meta).toMatchObject({ handlerType: 'meta', format: 'gpmd', sampleCount: 3 });
    expect(meta?.samples.times).toEqual([0, 1001, 2002]);
  });

  it('reads concatenated sample payloads', async () => {
    const reader = new MemoryReader(goproLikeFile());
    const info = await parseMp4(reader);
    const data = await readTrackSamples(reader, info.tracks[1]!);
    expect(Array.from(data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('rejects files without moov', async () => {
    await expect(parseMp4(new MemoryReader(new Uint8Array(4)))).rejects.toBeInstanceOf(Mp4ParseError);
  });
});

describe('video probing', () => {
  it('describes the video', async () => {
    const info = await probeVideo(new MemoryReader(goproLikeFile()), 'C:\\videos\\GX010001.MP4');
    expect(info).toMatchObject({
      fileName: 'GX010001.MP4',
      width: 3840,
      height: 2160,
      frameCount: 60,
      codec: 'hvc1',
      hasGpmf: true,
    });
    expect(info.frameRate).toBeCloseTo(59.94, 2);
    expect(info.durationSeconds).toBeCloseTo(1.001, 3);
  });

  it('extracts the GPMF track with gpmf-extract compatible timing', async () => {
    const gpmf = await extractGpmf(new MemoryReader(goproLikeFile()));
    expect(gpmf?.rawData.byteLength).toBe(9);
    expect(gpmf?.timing.samples).toEqual([
      { cts: 0, duration: 1001 },
      { cts: 1001, duration: 1001 },
      { cts: 2002, duration: 1001 },
    ]);
    expect(gpmf?.timing.frameDuration).toBeCloseTo(1001 / 60000, 6);
  });

  it('returns null when there is no GPMF track', async () => {
    const file = buildMp4([
      {
        id: 1,
        handler: 'vide',
        format: 'avc1',
        timescale: 30,
        sampleDelta: 1,
        samples: [new Uint8Array(1)],
        width: 1920,
        height: 1080,
      },
    ]);
    expect(await extractGpmf(new MemoryReader(file))).toBeNull();
  });
});
