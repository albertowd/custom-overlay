import { describe, expect, it } from 'vitest';
import { MemoryReader } from '../src/io/reader.js';
import { goproDevicesToSeries } from '../src/loaders/gopro.js';
import { findKlv, klvString } from '../src/media/gpmf-klv.js';
import { probeVideo } from '../src/media/probe.js';
import { ascii, box, buildMp4, klv, u32 } from './helpers/mp4-builder.js';

// Camera clock stored as local time "2024-05-01 10:00:00" (no timezone).
const LOCAL_CLOCK_MS = Date.UTC(2024, 4, 1, 10);
const CREATION = LOCAL_CLOCK_MS / 1000 + 2_082_844_800;

function gopro(): Uint8Array {
  const cdat = new Uint8Array(8);
  new DataView(cdat.buffer).setBigUint64(0, BigInt(LOCAL_CLOCK_MS / 1000 + 2));
  const gpmf = klv(
    'DEVC',
    0,
    1,
    new Uint8Array([...klv('MINF', 'c', 1, ascii('HERO12 Black')), ...klv('CDAT', 'J', 8, cdat)]),
  );
  return buildMp4(
    [{ id: 1, handler: 'vide', format: 'hvc1', timescale: 30, sampleDelta: 1, samples: [new Uint8Array(1)] }],
    CREATION,
    1000,
    [box('FIRM', ascii('H23.01.01.10.00\0')), box('GPMF', gpmf)],
  );
}

describe('camera metadata', () => {
  it('reads the clock readings and camera identity from moov/udta', async () => {
    const info = await probeVideo(new MemoryReader(gopro()), 'GX01.MP4');
    expect(info.camera).toEqual({ model: 'HERO12 Black', firmware: 'H23.01.01.10.00' });
    expect(info.clock).toEqual([
      { source: 'mvhd', epochMs: LOCAL_CLOCK_MS },
      { source: 'cdat', epochMs: LOCAL_CLOCK_MS + 2000 },
    ]);
  });

  it('reads colour description and bit depth from the sample entry', async () => {
    // nclx: BT.2020 primaries (9), HLG transfer (18), BT.2020 matrix (9), full range
    const colr = box('colr', ascii('nclx'), new Uint8Array([0, 9, 0, 18, 0, 9, 0x80]));
    const hvcC = new Uint8Array(23);
    hvcC[17] = 0xfa; // bitDepthLumaMinus8 = 2
    const file = buildMp4([
      {
        id: 1,
        handler: 'vide',
        format: 'hvc1',
        timescale: 30,
        sampleDelta: 1,
        samples: [new Uint8Array(1)],
        entryBoxes: [box('hvcC', hvcC), colr],
      },
    ]);
    const info = await probeVideo(new MemoryReader(file), 'hlg.mp4');
    expect(info.color).toEqual({ space: 'rec2020-hlg', range: 'full', bitDepth: 10 });
    const plain = await probeVideo(new MemoryReader(gopro()), 'x.mp4');
    expect(plain.color).toEqual({ space: 'rec709', range: 'limited', bitDepth: 8 });
  });

  it('finds nested KLV entries', () => {
    const data = klv('DEVC', 0, 1, klv('STRM', 0, 1, klv('STNM', 'c', 1, ascii('GPS'))));
    expect(klvString(findKlv(data, 'STNM'))).toBe('GPS');
    expect(findKlv(data, 'NOPE')).toBeNull();
    expect(Array.from(u32(1))).toEqual([0, 0, 0, 1]);
  });
});

describe('GPS fix filtering', () => {
  it('ignores samples recorded without a GPS lock', () => {
    const series = goproDevicesToSeries(
      {
        '1': {
          streams: {
            GPS5: {
              samples: [
                { cts: 0, date: new Date(1_000_000), value: [0, 0, 0, 0, 0], sticky: { fix: 0 } },
                { cts: 100, date: new Date(5_100), value: [1, 2, 3, 4, 5], sticky: { fix: 3 } },
                { cts: 200, date: new Date(5_200), value: [1, 2, 3, 4, 5] },
              ],
            },
          },
        },
      },
      'x',
    );
    const latitude = series?.channels.find((c) => c.key === 'latitude');
    expect(Number.isNaN(latitude?.values[0])).toBe(true);
    expect(latitude?.values[2]).toBe(1);
    expect(series?.startEpochMs).toBe(5_000);
  });
});
