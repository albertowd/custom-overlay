import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { raceChronoCsv, run, tempDir } from './helpers.js';

let dir: Awaited<ReturnType<typeof tempDir>>;
let project: string;

const SCRIPTS = [
  { id: 'lap.target', name: 'Target lap', unit: 's', code: 'return 95.5;' },
  { id: 'broken', name: 'Broken', code: "throw new Error('boom');" },
  { id: 'speed', name: 'Speed (fixed)', unit: 'm/s', code: 'return 7;' },
];

const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

beforeAll(async () => {
  dir = await tempDir();
  const csv = await raceChronoCsv(dir.path);
  project = join(dir.path, 'values.overlay.json');
  await run('project', 'init', project, '--name', 'Club race', '--source', csv);
  await writeFile(project, JSON.stringify({ ...(await readJson(project)), values: SCRIPTS }));
});
afterAll(() => dir.remove());

describe('values list', () => {
  it('shows every value at the timeline start', async () => {
    const lines = (await run('values', 'list', project)).stdout.split('\n');
    expect(lines[0]).toBe('Values at 0.000 s (frame 0 of 301 at 60 fps)');
    expect(lines[2]).toMatch(/^id\s+name\s+origin\s+value$/);
    const row = (id: string) => lines.find((l) => l.startsWith(`${id} `))?.split(/\s{2,}/);
    expect(row('lap.target')).toEqual(['lap.target', 'Target lap', 'script', '1:35.500']);
    expect(row('racechrono.speed')).toEqual(['racechrono.speed', 'Speed (100: gps)', 'source', '20 m/s']);
    expect(row('speed')?.slice(0, 2)).toEqual(['speed', 'Speed (fixed)']);
    expect(row('speed')?.[2]).toMatch(/^script \(replaces .+\)$/);
    expect(row('speed')?.[3]).toBe('7 m/s');
    expect(row('broken')?.[3]).toMatch(/^error: .*boom/);
  });

  it('evaluates at another time and frame rate', async () => {
    const { stdout } = await run('values', 'list', project, '--at', '2', '--rate', '10');
    expect(stdout.split('\n')[0]).toBe('Values at 2.000 s (frame 20 of 51 at 10 fps)');
    expect(stdout).toMatch(/^session\.elapsed\s+Session elapsed\s+builtin\s+2 s$/m);
  });

  it('prints JSON with the grid, values and errors', async () => {
    const json = JSON.parse((await run('values', 'list', project, '--json')).stdout);
    expect(json.time).toBe(0);
    expect(json.grid).toEqual({ start: 0, frameRate: 60, count: 301 });
    const value = (id: string) => json.values.find((v: { id: string }) => v.id === id);
    expect(value('lap.target')).toMatchObject({ origin: 'script', value: 95.5 });
    expect(value('broken')).toMatchObject({ value: null });
    expect(value('broken').error).toContain('boom');
  });

  it('rejects options that are not numbers', async () => {
    await expect(run('values', 'list', project, '--at', 'soon')).rejects.toThrow(
      "expected a number, got 'soon'",
    );
  });
});

describe('values export / import', () => {
  it('exports the scripts with the project name by default', async () => {
    const output = join(dir.path, 'default.values.json');
    expect((await run('values', 'export', project, output)).stdout.trim()).toBe(
      `3 value scripts written to ${output}`,
    );
    const collection = await readJson(output);
    expect(collection.name).toBe('Club race values');
    expect(collection.values.map((v: { id: string }) => v.id)).toEqual(['lap.target', 'broken', 'speed']);
  });

  it('exports under the given name', async () => {
    const output = join(dir.path, 'named.values.json');
    await run('values', 'export', project, output, '--name', 'My car');
    expect((await readJson(output)).name).toBe('My car');
  });

  it('imports a collection, replacing scripts with the same id', async () => {
    const collection = join(dir.path, 'import.values.json');
    await writeFile(
      collection,
      JSON.stringify({
        version: 1,
        name: 'Fixes',
        values: [
          { id: 'broken', name: 'Fixed', code: 'return 1;' },
          { id: 'fuel', name: 'Fuel', unit: 'l', code: 'return 40;' },
        ],
      }),
    );
    expect((await run('values', 'import', project, collection)).stdout.trim()).toBe(
      "Imported 2 value scripts from 'Fixes'",
    );
    const values = (await readJson(project)).values as { id: string; name: string }[];
    expect(values.map((v) => v.id)).toEqual(['lap.target', 'speed', 'broken', 'fuel']);
    expect(values.find((v) => v.id === 'broken')?.name).toBe('Fixed');
  });
});
