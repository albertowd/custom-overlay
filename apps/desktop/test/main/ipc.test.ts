import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  addSource,
  addVideo,
  createProject,
  createTemplate,
  createWidget,
  type Project,
  type ValueCollection,
  type VideoInfo,
} from '@custom-overlay/core';
import { loadVideo, writeProjectFile, writeTemplateFile } from '@custom-overlay/core/node';
import type { LoadedVideoPayload } from '@custom-overlay/ui/api';
import { projectMedia } from '@custom-overlay/ui/host';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelExport, startExport } from '../../src/main/export';
import { registerIpcHandlers } from '../../src/main/ipc';
import { remoteTrackCatalog } from '../../src/main/tracks';
import { IpcChannel } from '../../src/shared/ipc';
import { BrowserWindow, dialog, invoke, paths, shell } from './electron-mock';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('../../src/main/export', () => ({
  startExport: vi.fn(async () => 'exported'),
  cancelExport: vi.fn(),
}));
vi.mock('../../src/main/tracks', () => ({ remoteTrackCatalog: vi.fn(async () => null) }));
vi.mock('@custom-overlay/core/node', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@custom-overlay/core/node')>()),
  loadVideo: vi.fn(),
}));

const DJI_FIXTURE = resolve(
  import.meta.dirname,
  '../../../../packages/core/test/fixtures/dji/mini4pro-clip.srt',
);

let root: string;
let window: BrowserWindow;

const open = (...filePaths: string[]) =>
  dialog.showOpenDialog.mockResolvedValueOnce({ canceled: filePaths.length === 0, filePaths });
const saveAs = (filePath: string | null) =>
  dialog.showSaveDialog.mockResolvedValueOnce(filePath ? { canceled: false, filePath } : { canceled: true });
const lastOpenOptions = () =>
  dialog.showOpenDialog.mock.calls.at(-1)?.[1] as unknown as Electron.OpenDialogOptions;
const lastSaveOptions = () =>
  dialog.showSaveDialog.mock.calls.at(-1)?.[1] as unknown as Electron.SaveDialogOptions;

/** A file under the test folder, created (empty) when `content` is given. */
function file(name: string, content?: string): string {
  const path = join(root, name);
  if (content !== undefined) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return path;
}

function videoInfo(path: string): VideoInfo {
  return {
    path,
    fileName: 'clip.mp4',
    sizeBytes: 1,
    durationSeconds: 10,
    width: 1920,
    height: 1080,
    frameRate: 30,
    frameCount: 300,
    codec: 'avc1',
    creationTime: null,
    hasGpmf: false,
    hasAudio: false,
    color: { space: 'rec709', range: 'limited', bitDepth: 8 },
    camera: { model: null, firmware: null },
    clock: [],
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'co-ipc-'));
  paths.userData = file('user');
  paths.videos = file('Videos');
  paths.documents = file('Documents');
  for (const folder of [paths.userData, paths.videos, paths.documents]) mkdirSync(folder as string);
  registerIpcHandlers();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  window = new BrowserWindow();
  BrowserWindow.current = window;
});

describe('language', () => {
  it('gets and saves the app language, refusing unknown ones', async () => {
    expect(await invoke(IpcChannel.getLanguage)).toBe('en');
    await invoke(IpcChannel.setLanguage, 'it');
    expect(await invoke(IpcChannel.getLanguage)).toBe('it');
    await expect(invoke(IpcChannel.setLanguage, 'xx')).rejects.toThrow('Unsupported language: xx');
    await invoke(IpcChannel.setLanguage, 'en');
  });
});

describe('opening media', () => {
  it('asks for videos in the media folder and remembers where they were', async () => {
    const a = file('rides/a.mp4', '');
    const b = file('rides/b.mp4', '');
    open(a, b);
    expect(await invoke(IpcChannel.selectVideos)).toEqual([a, b]);
    expect(dialog.showOpenDialog.mock.calls.at(-1)?.[0]).toBe(window);
    expect(lastOpenOptions()).toMatchObject({
      title: 'Add videos',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Videos', extensions: expect.arrayContaining(['mp4', 'MOV']) }],
    });

    open();
    expect(await invoke(IpcChannel.selectVideos)).toEqual([]);
    expect(lastOpenOptions().defaultPath).toBe(file('rides'));
  });

  it('needs the window that asked', async () => {
    BrowserWindow.current = null;
    await expect(invoke(IpcChannel.selectVideos)).rejects.toThrow('No window for this request');
  });

  it('keeps only telemetry files it can read', async () => {
    open(file('log.csv'), file('drone.SRT'), file('clip.mp4'), file('notes.txt'));
    expect(await invoke(IpcChannel.selectSources)).toEqual([
      { path: file('log.csv'), kind: 'racechrono' },
      { path: file('drone.SRT'), kind: 'dji' },
      { path: file('clip.mp4'), kind: 'gopro' },
    ]);
    expect(lastOpenOptions().filters?.map((f) => f.name)).toContain('RaceChrono CSV');
    expect(await invoke(IpcChannel.detectSourceKind, '/x/y.csv')).toBe('racechrono');
    expect(await invoke(IpcChannel.detectSourceKind, '/x/y.txt')).toBeNull();
  });

  it('loads a video, serves it on media:// and keeps it for value scripts', async () => {
    const path = file('loaded/clip.mp4', '');
    const info = videoInfo(path);
    vi.mocked(loadVideo).mockResolvedValueOnce({ info, telemetry: null });
    const payload = await invoke<LoadedVideoPayload>(IpcChannel.loadVideo, path);
    expect(payload).toMatchObject({ info, telemetry: null });
    expect(payload.mediaUrl).toMatch(/^media:\/\/file\//);

    const { project, video } = addVideo(createProject(), { path, info, hasTelemetry: false });
    expect(projectMedia(project).videos[video.id]).toBe(info);
  });

  it('loads a telemetry file and keeps it for value scripts', async () => {
    const series = await invoke<{ channels: unknown[] }>(IpcChannel.loadSource, DJI_FIXTURE, 'dji');
    expect(series.channels.length).toBeGreaterThan(0);
    const { project, source } = addSource(createProject(), { kind: 'dji', path: DJI_FIXTURE });
    expect(projectMedia(project).series[source.id]).toBe(series);
  });
});

describe('GoPro chapters', () => {
  let folder: string;
  let chapter: (n: number) => string;

  beforeAll(() => {
    folder = file('gopro');
    mkdirSync(folder);
    chapter = (n: number) => join(folder, `GX0${n}0042.MP4`);
    for (const n of [1, 2, 3]) writeFileSync(chapter(n), '');
    writeFileSync(join(folder, 'GX010099.MP4'), '');
    writeFileSync(join(folder, 'GX020099.MP4'), '');
    writeFileSync(join(folder, 'other.mp4'), '');
  });

  it('adds whole recordings in order when the user agrees', async () => {
    dialog.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    expect(await invoke(IpcChannel.withChapters, [chapter(2)], [])).toEqual([
      chapter(1),
      chapter(2),
      chapter(3),
    ]);
    const options = dialog.showMessageBox.mock.calls.at(-1)?.[1] as unknown as Electron.MessageBoxOptions;
    expect(options.message).toBe('This video is part of a longer GoPro recording');
    expect(options.detail).toContain('GX010042.MP4 … GX030042.MP4 (3 files)');
    expect(options.detail).toContain('Add the 2 other chapters too?');
  });

  it('asks once for several recordings and skips videos already in the project', async () => {
    dialog.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    const other = join(folder, 'GX020099.MP4');
    const added = await invoke(IpcChannel.withChapters, [chapter(1), other], [chapter(3)]);
    expect(added).toEqual([chapter(1), chapter(2), join(folder, 'GX010099.MP4'), other]);
    expect(dialog.showMessageBox).toHaveBeenCalledOnce();
    const options = dialog.showMessageBox.mock.calls[0]?.[1] as unknown as Electron.MessageBoxOptions;
    expect(options.message).toBe('These videos are part of longer GoPro recordings');
    expect(options.detail).toContain('Add the 2 other chapters too?');
  });

  it('adds only the selection when the user declines', async () => {
    dialog.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    expect(await invoke(IpcChannel.withChapters, [chapter(2), chapter(2)], [])).toEqual([chapter(2)]);
  });

  it('does not ask without other chapters', async () => {
    const lone = join(folder, 'other.mp4');
    const missing = join(root, 'nowhere', 'GX010001.MP4');
    expect(await invoke(IpcChannel.withChapters, [lone, missing], [lone.toUpperCase()])).toEqual([missing]);
    expect(await invoke(IpcChannel.withChapters, [chapter(1), chapter(2)], [chapter(3)])).toEqual([
      chapter(1),
      chapter(2),
    ]);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });
});

describe('export and shell', () => {
  it('starts and cancels exports for the window that asked', async () => {
    const project = createProject();
    expect(await invoke(IpcChannel.startExport, project)).toBe('exported');
    expect(startExport).toHaveBeenCalledWith(window.webContents, project);
    await invoke(IpcChannel.cancelExport);
    expect(cancelExport).toHaveBeenCalled();
  });

  it('reveals files and opens only pages of the project', async () => {
    await invoke(IpcChannel.revealPath, '/out/overlay.mp4');
    expect(shell.showItemInFolder).toHaveBeenCalledWith('/out/overlay.mp4');

    await invoke(IpcChannel.openProjectUrl, 'https://github.com/albertowd/custom-overlay/releases');
    expect(shell.openExternal).toHaveBeenCalledWith('https://github.com/albertowd/custom-overlay/releases');
    await expect(invoke(IpcChannel.openProjectUrl, 'https://evil.example')).rejects.toThrow(
      'Only pages of the project can be opened',
    );
  });

  it('answers app information, update checks and the track catalog', async () => {
    expect(await invoke(IpcChannel.appInfo)).toMatchObject({ name: 'Custom Overlay' });
    expect(await invoke(IpcChannel.checkForUpdate)).toBeNull();
    expect(await invoke(IpcChannel.trackCatalog)).toBeNull();
    expect(remoteTrackCatalog).toHaveBeenCalled();
  });

  it('evaluates project values', async () => {
    const snapshot = await invoke<{ grid: { frameRate: number } }>(
      IpcChannel.evaluateValues,
      createProject(),
      25,
    );
    expect(snapshot.grid.frameRate).toBe(25);
  });
});

describe('files', () => {
  it('opens and saves widgets with a safe suggested name', async () => {
    const widget = createWidget('text', { name: 'Speed: <fast>?. ' });
    const saved = file('Documents/w.widget.json');
    saveAs(saved);
    expect(await invoke(IpcChannel.saveWidget, widget)).toBe(saved);
    expect(basename(lastSaveOptions().defaultPath as string)).toBe('Speed_ _fast__.widget.json');
    open(saved);
    expect(await invoke(IpcChannel.openWidgets)).toEqual([widget]);

    saveAs(null);
    expect(await invoke(IpcChannel.saveWidget, createWidget('text', { name: ' .. ' }))).toBeNull();
    expect(lastSaveOptions().defaultPath).toBe(join(file('Documents'), 'text.widget.json'));
    open();
    expect(await invoke(IpcChannel.openWidgets)).toEqual([]);
  });

  it('reads the widgets of a template', async () => {
    const template = { ...createTemplate(), widgets: [createWidget('text'), createWidget('speed-gauge')] };
    const path = file('t.template.json');
    await writeTemplateFile(path, template);
    open(path);
    expect(await invoke(IpcChannel.openWidgets)).toEqual(template.widgets);
  });

  it('opens and saves tracks', async () => {
    const track = { ...createProject().track, name: 'Interlagos' };
    const saved = file('tracks/t.track.json');
    mkdirSync(file('tracks'), { recursive: true });
    saveAs(saved);
    expect(await invoke(IpcChannel.saveTrack, track)).toBe(saved);
    expect(lastSaveOptions().defaultPath).toMatch(/Interlagos\.track\.json$/);
    open(saved);
    expect(await invoke(IpcChannel.openTrack)).toEqual(track);

    saveAs(null);
    expect(await invoke(IpcChannel.saveTrack, { ...track, name: '' })).toBeNull();
    expect(lastSaveOptions().defaultPath).toBe(join(file('tracks'), 'track.track.json'));
    open();
    expect(await invoke(IpcChannel.openTrack)).toBeNull();
  });

  it('opens and saves value collections', async () => {
    const collection: ValueCollection = { version: 1, name: 'My values', values: [] };
    const saved = file('v.values.json');
    saveAs(saved);
    expect(await invoke(IpcChannel.saveValueCollection, collection)).toBe(saved);
    expect(lastSaveOptions().defaultPath).toMatch(/My values\.values\.json$/);
    open(saved);
    expect(await invoke(IpcChannel.openValueCollection)).toEqual(collection);

    saveAs(null);
    expect(await invoke(IpcChannel.saveValueCollection, { ...collection, name: '' })).toBeNull();
    expect(lastSaveOptions().defaultPath).toMatch(/[\\/]values\.values\.json$/);
    open();
    expect(await invoke(IpcChannel.openValueCollection)).toBeNull();
  });

  it('opens and saves templates', async () => {
    const template = { ...createTemplate(), name: 'Race' };
    const saved = file('race.template.json');
    saveAs(saved);
    expect(await invoke(IpcChannel.saveTemplate, template)).toBe(saved);
    expect(lastSaveOptions().defaultPath).toMatch(/Race\.template\.json$/);
    open(saved);
    expect(await invoke(IpcChannel.openTemplate)).toEqual({ path: saved, template });

    saveAs(null);
    expect(await invoke(IpcChannel.saveTemplate, { ...template, name: '' })).toBeNull();
    expect(lastSaveOptions().defaultPath).toMatch(/[\\/]template\.template\.json$/);
    open();
    expect(await invoke(IpcChannel.openTemplate)).toBeNull();
  });
});

describe('projects', () => {
  const named = (name: string): Project => ({ ...createProject(), name });

  it('opens a project file', async () => {
    const path = file('open/p.overlay.json');
    mkdirSync(file('open'), { recursive: true });
    await writeProjectFile(path, named('Opened'));
    open(path);
    expect(await invoke(IpcChannel.openProject)).toMatchObject({ path, project: { name: 'Opened' } });
    open();
    expect(await invoke(IpcChannel.openProject)).toBeNull();
  });

  it('opens the project passed on the command line', async () => {
    const path = file('startup.overlay.json');
    await writeProjectFile(path, named('Startup'));
    const argv = process.argv;
    try {
      process.argv = [...argv, path];
      expect(await invoke(IpcChannel.startupProject)).toMatchObject({ path, project: { name: 'Startup' } });
      process.argv = [...argv, file('missing.OVERLAY.JSON')];
      expect(await invoke(IpcChannel.startupProject)).toBeNull();
      process.argv = argv;
      expect(await invoke(IpcChannel.startupProject)).toBeNull();
    } finally {
      process.argv = argv;
    }
  });

  it('saves to the known path without asking', async () => {
    const path = file('known.overlay.json');
    expect(await invoke(IpcChannel.saveProject, path, named('Known'))).toBe(path);
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ name: 'Known' });
  });

  it('suggests saving a new project next to its media', async () => {
    const media = file('session/clip.mp4', '');
    const { project } = addVideo(named('Track day / 1'), {
      path: media,
      info: videoInfo(media),
      hasTelemetry: false,
    });
    const target = file('session/day.overlay.json');
    saveAs(target);
    expect(await invoke(IpcChannel.saveProject, null, project)).toBe(target);
    expect(lastSaveOptions().defaultPath).toBe(join(file('session'), 'Track day _ 1.overlay.json'));
    expect(existsSync(target)).toBe(true);
  });

  it('suggests the last project folder when the media folder is gone, and can be cancelled', async () => {
    const { project } = addSource(named(''), { kind: 'racechrono', path: file('deleted/log.csv') });
    saveAs(null);
    expect(await invoke(IpcChannel.saveProject, null, project)).toBeNull();
    expect(lastSaveOptions().defaultPath).toBe(join(file('session'), 'project.overlay.json'));
  });
});

describe('export output', () => {
  beforeEach(async () => {
    // Media dialogs start where videos were last picked.
    open(file('rides/a.mp4'));
    await invoke(IpcChannel.selectVideos);
  });

  it('asks for a folder for image sequences', async () => {
    open(file('frames'));
    expect(await invoke(IpcChannel.selectOutput, 'image-sequence', file('out/frames/frame.png'))).toBe(
      file('frames'),
    );
    expect(lastOpenOptions()).toMatchObject({
      defaultPath: file('out/frames'),
      properties: ['openDirectory', 'createDirectory'],
    });

    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] });
    expect(await invoke(IpcChannel.selectOutput, 'image-sequence', null)).toBeNull();
    expect(lastOpenOptions().defaultPath).toBe(file('rides'));
    open();
    expect(await invoke(IpcChannel.selectOutput, 'image-sequence')).toBeNull();
  });

  it('asks for an MP4 file for videos', async () => {
    saveAs(file('out.mp4'));
    expect(await invoke(IpcChannel.selectOutput, 'video', file('suggested.mp4'))).toBe(file('out.mp4'));
    expect(lastSaveOptions()).toMatchObject({
      defaultPath: file('suggested.mp4'),
      filters: [{ extensions: ['mp4'] }],
    });

    saveAs(null);
    expect(await invoke(IpcChannel.selectOutput, 'video')).toBeNull();
    expect(lastSaveOptions().defaultPath).toBe(join(file('rides'), 'overlay.mp4'));
  });
});
