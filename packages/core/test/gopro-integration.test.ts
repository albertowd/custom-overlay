import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getChannel, seriesTimeRange } from '../src/model/telemetry.js';
import { loadVideo } from '../src/node/index.js';
import { splitGpmfPayloads } from './helpers/gpmf.js';
import { buildMp4 } from './helpers/mp4-builder.js';

let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'custom-overlay-gpmf-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Wrap a raw GPMF capture in an MP4 with a dummy 29.97 fps video track. */
async function goproFile(fixture: string): Promise<string> {
  const raw = new Uint8Array(await readFile(new URL(`./fixtures/${fixture}`, import.meta.url)));
  const payloads = splitGpmfPayloads(raw);
  const frames = Array.from({ length: payloads.length * 30 }, () => new Uint8Array(1));
  const path = join(dir, `${fixture}.mp4`);
  await writeFile(
    path,
    buildMp4([
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
      { id: 2, handler: 'meta', format: 'gpmd', timescale: 1000, sampleDelta: 1001, samples: payloads },
    ]),
  );
  return path;
}

describe.each(['hero7.raw', 'hero11.raw'])('GoPro telemetry from %s', (fixture) => {
  it('extracts GPS and IMU channels on the video timeline', async () => {
    const { info, telemetry } = await loadVideo(await goproFile(fixture));
    expect(info.hasGpmf).toBe(true);
    expect(telemetry).not.toBeNull();
    const keys = telemetry?.channels.map((c) => c.key) ?? [];
    expect(keys).toEqual(expect.arrayContaining(['latitude', 'longitude', 'speed']));
    expect(keys.some((k) => k.startsWith('accel'))).toBe(true);

    const latitude = getChannel(telemetry!, 'latitude')!;
    expect(Math.abs(latitude.values[0] as number)).toBeGreaterThan(0);
    expect(Math.abs(latitude.values[0] as number)).toBeLessThanOrEqual(90);
    // Absolute time from the GPS clock
    expect(telemetry?.startEpochMs).toBeGreaterThan(Date.UTC(2015, 0, 1));
    const range = seriesTimeRange(telemetry!);
    expect(range.start).toBeGreaterThanOrEqual(0);
    expect(range.end).toBeLessThanOrEqual(info.durationSeconds + 1.1);
  });
});
