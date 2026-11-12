import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, paths } from './electron-mock';

vi.mock('electron', () => import('./electron-mock'));

const { claimLock, MAX_SLOTS, releaseLock, seedFolder, useOwnInstanceData } = await import(
  '../../src/main/instance'
);

let root = '';
/** A pid that is not running (larger than any real one). */
const GONE = 2 ** 30;

function write(path: string, text = 'x'): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'co-instance-'));
  paths.userData = root;
  app.setPath.mockClear();
  app.on.mockClear();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete paths.userData;
  delete paths.sessionData;
});

describe('lock files', () => {
  it('belong to one running process, and are taken over from a process that is gone', () => {
    const lock = join(root, 'a.lock');
    expect(claimLock(lock, 111)).toBe(true);
    // Held by this test process: another one cannot take it.
    writeFileSync(lock, String(process.pid));
    expect(claimLock(lock, 222)).toBe(false);
    writeFileSync(lock, String(GONE));
    expect(claimLock(lock, 222)).toBe(true);
    expect(readFileSync(lock, 'utf8')).toBe('222');
    releaseLock(lock, 333);
    expect(existsSync(lock)).toBe(true);
    releaseLock(lock, 222);
    expect(existsSync(lock)).toBe(false);
    releaseLock(lock, 222);
    expect(claimLock(join(root, 'missing', 'b.lock'))).toBe(false);
  });
});

describe('instance data', () => {
  it('gives the first copy slot 1, seeded from the data earlier versions shared', () => {
    write(join(root, 'Local Storage', 'leveldb', '000003.log'), 'prefs');
    write(join(root, 'Local Storage', 'leveldb', 'LOCK'));
    write(join(root, 'Code Cache', 'js', 'index'));
    write(join(root, 'Cache', 'Cache_Data', 'data_0'));
    const data = useOwnInstanceData();
    expect(data).toEqual({ slot: 1, folder: join(root, 'instances', '1'), seededFrom: root });
    expect(app.setPath).toHaveBeenCalledWith('sessionData', data.folder);
    expect(readFileSync(join(data.folder, 'Local Storage', 'leveldb', '000003.log'), 'utf8')).toBe('prefs');
    expect(existsSync(join(data.folder, 'Code Cache', 'js', 'index'))).toBe(true);
    // Locks and the HTTP cache are not copied.
    expect(existsSync(join(data.folder, 'Local Storage', 'leveldb', 'LOCK'))).toBe(false);
    expect(existsSync(join(data.folder, 'Cache'))).toBe(false);
    expect(readFileSync(join(root, 'instances', '1.lock'), 'utf8')).toBe(String(process.pid));
  });

  it('gives a second copy the next slot, and reuses a slot without copying again', () => {
    mkdirSync(join(root, 'instances', '1'), { recursive: true });
    mkdirSync(join(root, 'instances', '2'), { recursive: true });
    write(join(root, 'instances', '1.lock'), String(process.ppid));
    write(join(root, 'instances', '2.lock'), String(GONE));
    expect(useOwnInstanceData()).toEqual({ slot: 2, folder: join(root, 'instances', '2'), seededFrom: null });
  });

  it('releases its slot when the app quits', () => {
    useOwnInstanceData();
    const quit = app.on.mock.calls.find(([name]) => name === 'will-quit')?.[1] as () => void;
    quit();
    expect(existsSync(join(root, 'instances', '1.lock'))).toBe(false);
  });

  it('runs in a throwaway folder when every slot is taken', () => {
    for (let slot = 1; slot <= MAX_SLOTS; slot++)
      write(join(root, 'instances', `${slot}.lock`), String(process.ppid));
    const data = useOwnInstanceData();
    expect(data).toEqual({
      slot: null,
      folder: join(root, 'instances', `run-${process.pid}`),
      seededFrom: null,
    });
    expect(app.setPath).toHaveBeenCalledWith('sessionData', data.folder);
  });

  it('copies what it can read', () => {
    seedFolder(join(root, 'nothing'), join(root, 'empty'));
    expect(existsSync(join(root, 'empty'))).toBe(true);
  });
});
