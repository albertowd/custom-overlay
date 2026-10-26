import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { tempDir } from './helpers.js';

let dir: Awaited<ReturnType<typeof tempDir>>;
beforeAll(async () => {
  dir = await tempDir();
});
afterAll(() => dir.remove());

const argv = process.argv;
afterEach(() => {
  process.argv = argv;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

/** Run the `custom-overlay` executable entry with these arguments. */
async function main(...args: string[]): Promise<void> {
  process.argv = ['node', 'custom-overlay', ...args];
  vi.resetModules();
  await import('../src/index.js');
}

describe('custom-overlay executable', () => {
  it('runs the command given on the command line', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const output = join(dir.path, 'cli.template.json');
    await main('template', output);
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(`Template written to ${output}`));
    expect(existsSync(output)).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('prints the error and exits with 1 when the command fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const file = join(dir.path, 'notes.txt');
    await main('source', file);
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(error).toHaveBeenCalledWith(`error: Cannot detect the type of data source '${file}'`);
  });
});
