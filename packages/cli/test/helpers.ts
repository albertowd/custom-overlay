import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { vi } from 'vitest';
import { createProgram } from '../src/program.js';

// Core's MP4 / GPMF test builders live outside this package's rootDir: load them at run time.
interface CoreTestHelpers {
  splitGpmfPayloads(raw: Uint8Array): Uint8Array[];
  buildMp4(tracks: Record<string, unknown>[]): Uint8Array;
}

async function coreTestHelpers(): Promise<CoreTestHelpers> {
  const helper = (name: string) =>
    import(fileURLToPath(new URL(`../../core/test/helpers/${name}`, import.meta.url)));
  const [gpmf, mp4] = await Promise.all([helper('gpmf.ts'), helper('mp4-builder.ts')]);
  return { ...gpmf, ...mp4 } as CoreTestHelpers;
}

const FIXTURES = new URL('../../core/test/fixtures/', import.meta.url);

export const fixture = (name: string): string => fileURLToPath(new URL(name, FIXTURES));

export async function tempDir(): Promise<{ path: string; remove: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), 'custom-overlay-cli-'));
  return { path, remove: () => rm(path, { recursive: true, force: true }) };
}

/** What a command printed: console.log/error/warn lines and raw stderr writes. */
export interface Output {
  stdout: string;
  stderr: string;
}

/** Run `custom-overlay ...args` in process and capture what it prints. Rejects like the command. */
export async function run(...args: string[]): Promise<Output> {
  const out: string[] = [];
  const err: string[] = [];
  const text = (values: unknown[]) => values.map(String).join(' ');
  const spies = [
    vi.spyOn(console, 'log').mockImplementation((...v) => void out.push(text(v))),
    vi.spyOn(console, 'error').mockImplementation((...v) => void err.push(text(v))),
    vi.spyOn(console, 'warn').mockImplementation((...v) => void err.push(text(v))),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    }),
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    }),
  ];
  const output = (): Output => ({ stdout: out.join('\n'), stderr: err.join('\n') });
  try {
    // Commander only passes these settings to subcommands created afterwards: set them on every one.
    const configure = (command: Command): void => {
      command
        .exitOverride()
        .configureOutput({ writeOut: (s) => void out.push(s), writeErr: (s) => void err.push(s) });
      for (const sub of command.commands) configure(sub);
    };
    const program = createProgram();
    configure(program);
    await program.parseAsync(['node', 'custom-overlay', ...args]);
    return output();
  } catch (error) {
    throw Object.assign(error as Error, { output: output() });
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

/** A GoPro MP4 (dummy 29.97 fps video track + a real GPMF capture) written to `folder`. */
export async function goproVideo(folder: string, raw = 'hero7.raw'): Promise<string> {
  const { splitGpmfPayloads, buildMp4 } = await coreTestHelpers();
  const payloads = splitGpmfPayloads(new Uint8Array(await readFile(fixture(raw))));
  const frames = Array.from({ length: payloads.length * 30 }, () => new Uint8Array(1));
  const path = join(folder, `${raw}.mp4`);
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

/** A 2 second MP4 with a dummy video track and no telemetry, written to `folder`. */
export async function plainVideo(folder: string): Promise<string> {
  const { buildMp4 } = await coreTestHelpers();
  const frames = Array.from({ length: 60 }, () => new Uint8Array(1));
  const path = join(folder, 'plain.mp4');
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
        width: 1280,
        height: 720,
      },
    ]),
  );
  return path;
}

/** A small RaceChrono v3 CSV log written to `folder`. */
export async function raceChronoCsv(folder: string, name = 'session.csv'): Promise<string> {
  const rows = ['Timestamp,Lap #,Elapsed time,Distance traveled,Latitude,Longitude,Speed'];
  rows.push('unix time,,s,m,deg,deg,m/s', ',,,,100: gps,100: gps,100: gps');
  for (let i = 0; i <= 50; i++) {
    const t = i / 10;
    rows.push(
      `${(1714557600 + t).toFixed(3)},1,${t.toFixed(3)},${(t * 20).toFixed(1)},${(-23.7 - t / 1000).toFixed(5)},${(-46.69 - t / 1000).toFixed(5)},${(20 + Math.sin(t)).toFixed(2)}`,
    );
  }
  const csv = [
    'This file is created using RaceChrono v8.1.2 ( http://www.racechrono.com/ ).',
    'Format,3',
    'Session title,"Track day"',
    'Session type,Lap timing',
    'Track name,"Interlagos"',
    'Created,01/05/2024,10:00',
    '',
    ...rows,
  ].join('\r\n');
  const path = join(folder, name);
  await writeFile(path, csv);
  return path;
}
