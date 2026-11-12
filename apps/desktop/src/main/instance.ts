import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { app } from 'electron';

/**
 * Several copies of the app can run at once (one exporting while another edits). Chromium locks
 * its data folder (HTTP and code caches, Local Storage...), so each running copy gets a folder of
 * its own: a numbered slot, claimed with a lock file while the copy runs and reused afterwards,
 * so its caches stay warm. A new slot starts as a copy of the most recently used data (caches and
 * preferences), which is only read, never written. App settings stay shared in the user data folder.
 */

/** Slots tried before falling back to a throwaway folder. */
export const MAX_SLOTS = 16;

/** Chromium data worth copying into a new slot: compiled code, shaders, and the saved preferences. */
const SEED = ['Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'DawnGraphiteCache', 'Local Storage'];

/** Files Chromium keeps locked or that belong to one process only. */
const SKIPPED_FILES = new Set(['LOCK', 'lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']);

/** Whether a process is still running. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // No permission to signal it: it exists.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Take a lock file for this process; a lock left by a process that is gone is taken over. */
export function claimLock(path: string, pid = process.pid): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(pid));
      closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      const owner = Number.parseInt(readFileSync(path, 'utf8'), 10);
      if (Number.isFinite(owner) && owner !== pid && alive(owner)) return false;
      rmSync(path, { force: true });
    }
  }
  return false;
}

export function releaseLock(path: string, pid = process.pid): void {
  try {
    if (Number.parseInt(readFileSync(path, 'utf8'), 10) === pid) rmSync(path, { force: true });
  } catch {
    // Already gone.
  }
}

/** Last time a data folder was used (its preferences change on every run), 0 when unknown. */
function lastUsed(folder: string): number {
  for (const marker of ['Preferences', 'Local Storage', '.']) {
    try {
      return statSync(join(folder, marker)).mtimeMs;
    } catch {
      // Try the next one.
    }
  }
  return 0;
}

/** Copy the reusable Chromium data of a folder into a new one, skipping what cannot be read. */
export function seedFolder(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const name of SEED) {
    const source = join(from, name);
    if (!existsSync(source)) continue;
    try {
      cpSync(source, join(to, name), {
        recursive: true,
        force: false,
        errorOnExist: false,
        filter: (path) => !SKIPPED_FILES.has(basename(path)),
      });
    } catch {
      // A file in use by the other copy: it only starts colder.
    }
  }
}

export interface InstanceData {
  /** Slot number, null for a throwaway folder (all slots taken). */
  slot: number | null;
  folder: string;
  /** Folder the new slot was seeded from, null when it existed already (or nothing to copy). */
  seededFrom: string | null;
}

/**
 * Point this process's Chromium data at a folder of its own. Call before the app is ready.
 * `shared` is where earlier versions kept that data (the user data folder).
 */
export function useOwnInstanceData(): InstanceData {
  const shared = app.getPath('userData');
  const root = join(shared, 'instances');
  mkdirSync(root, { recursive: true });
  const slots = Array.from({ length: MAX_SLOTS }, (_, i) => i + 1);
  for (const slot of slots) {
    const folder = join(root, String(slot));
    const lock = `${folder}.lock`;
    if (!claimLock(lock)) continue;
    let seededFrom: string | null = null;
    if (!existsSync(folder)) {
      // The most recently used data among the other slots and the shared folder.
      const sources = [shared, ...slots.filter((s) => s !== slot).map((s) => join(root, String(s)))]
        .filter((candidate) => existsSync(candidate))
        .sort((a, b) => lastUsed(b) - lastUsed(a));
      seededFrom = sources[0] ?? null;
      if (seededFrom) seedFolder(seededFrom, folder);
      else mkdirSync(folder, { recursive: true });
    }
    app.setPath('sessionData', folder);
    app.on('will-quit', () => releaseLock(lock));
    process.on('exit', () => releaseLock(lock));
    return { slot, folder, seededFrom };
  }
  // Every slot is in use: a folder for this run only.
  const folder = join(root, `run-${process.pid}`);
  mkdirSync(folder, { recursive: true });
  app.setPath('sessionData', folder);
  process.on('exit', () => rmSync(folder, { recursive: true, force: true }));
  return { slot: null, folder, seededFrom: null };
}
