import {
  createProject,
  createWidget,
  type Project,
  serializeProject,
  serializeTemplate,
  type Track,
  TrackSchema,
  type ValueCollection,
} from '@custom-overlay/core';
import type { AppApi } from '@custom-overlay/ui/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import catalogFile from '../../../../packages/core/src/tracks/catalog.json';
import { runInEngine } from '../../src/engine';
import { exportImageSequence } from '../../src/export';
import { abortError, type FakeFileHandle, fileHandle, folderHandle, mockFileInput } from './helpers';

vi.mock('../../src/engine', () => ({ runInEngine: vi.fn() }));
vi.mock('../../src/export', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/export')>()),
  exportImageSequence: vi.fn(),
}));

let api: AppApi;

/** A fresh web API (its files, cached track list and running export are module state). */
async function freshApi(): Promise<AppApi> {
  vi.resetModules();
  api = (await import('../../src/web-api')).webApi;
  return api;
}

/** The open picker answers with these files. */
function pickFiles(...files: File[]) {
  const picker = vi.fn(async () => files.map((file) => fileHandle(file)));
  window.showOpenFilePicker = picker;
  return picker;
}

/** The save picker answers with a new file; returns what gets written to it. */
function saveTo(name: string): FakeFileHandle {
  const handle = fileHandle(new File([], name));
  window.showSaveFilePicker = vi.fn(async () => handle);
  return handle;
}

const writtenText = async (handle: FakeFileHandle) => (handle.written.at(-1) as Blob).text();

beforeEach(async () => {
  localStorage.clear();
  await freshApi();
});

afterEach(() => {
  delete window.showOpenFilePicker;
  delete window.showSaveFilePicker;
  delete window.showDirectoryPicker;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('host', () => {
  it('leaves videos to the desktop app and downloads sequences without a folder picker', async () => {
    expect(api.capabilities).toEqual({ videoExport: false, revealFiles: false, sequenceAsZip: true });
    window.showDirectoryPicker = async () => folderHandle('frames');
    expect((await freshApi()).capabilities.sequenceAsZip).toBe(false);
  });

  it('describes the app and never offers installers', async () => {
    expect(await api.appInfo()).toEqual({
      name: 'Custom Overlay',
      version: '0.1.0',
      author: 'Alberto',
      homepage: 'https://github.com/albertowd/custom-overlay',
    });
    expect(await api.checkForUpdate()).toBeNull();
    expect(await api.getStartupProject()).toBeNull();
    await expect(api.revealPath('frames')).resolves.toBeUndefined();
  });

  it('opens pages of the project only', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await api.openProjectUrl('https://github.com/albertowd/custom-overlay/releases');
    expect(open).toHaveBeenCalledWith(
      'https://github.com/albertowd/custom-overlay/releases',
      '_blank',
      'noopener',
    );
    await expect(api.openProjectUrl('https://example.com')).rejects.toThrow('Only pages of the project');
  });
});

describe('language', () => {
  it('keeps the chosen language', async () => {
    await api.setLanguage('it');
    expect(await api.getLanguage()).toBe('it');
  });

  it('follows the browser languages without a valid choice', async () => {
    localStorage.setItem('custom-overlay.language', 'xx');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['pt-PT', 'en']);
    expect(await api.getLanguage()).toBe('pt-BR');
  });

  it('still works without storage', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['ja-JP']);
    await expect(api.setLanguage('es')).resolves.toBeUndefined();
    expect(await api.getLanguage()).toBe('ja');
  });
});

describe('media', () => {
  it('adds videos and data sources picked in the browser', async () => {
    const picker = pickFiles(new File([], 'GX010082.MP4'), new File([], 'GX020082.MP4'));
    expect(await api.selectVideos()).toEqual(['GX010082.MP4', 'GX020082.MP4']);
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ id: 'media', multiple: true }));
    pickFiles(new File([], 'lap.csv'), new File([], 'DJI_0001.SRT'), new File([], 'notes.txt'));
    expect(await api.selectSources()).toEqual([
      { path: 'lap.csv', kind: 'racechrono' },
      { path: 'DJI_0001.SRT', kind: 'dji' },
    ]);
    expect(await api.detectSourceKind('clip.MOV')).toBe('gopro');
  });

  it('puts GoPro chapters selected together in recording order, without those in the project', async () => {
    expect(await api.withChapters(['GX020082.MP4', 'GX010082.MP4'], [])).toEqual([
      'GX010082.MP4',
      'GX020082.MP4',
    ]);
    expect(
      await api.withChapters(['GX020082.MP4', 'GX010082.MP4', 'DJI_0001.MP4'], ['../cards/gx010082.mp4']),
    ).toEqual(['GX020082.MP4', 'DJI_0001.MP4']);
  });

  it('loads a dropped video in the engine and plays it from an object URL', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:video');
    const video = new File(['v'], 'DJI_0001.MP4');
    const subtitles = new File(['s'], 'DJI_0001.srt');
    expect(api.getPathForFile(video)).toBe('DJI_0001.MP4');
    api.getPathForFile(subtitles);
    const loaded = { info: { fileName: 'DJI_0001.MP4' }, telemetry: null };
    vi.mocked(runInEngine).mockResolvedValue(loaded as never);
    expect(await api.loadVideo('DJI_0001.MP4')).toEqual({ ...loaded, mediaUrl: 'blob:video' });
    expect(runInEngine).toHaveBeenCalledWith('loadVideo', { path: 'DJI_0001.MP4', file: video, subtitles });
    // One object URL per file, however often it loads.
    await api.loadVideo('../other/DJI_0001.MP4');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('loads a data source in the engine', async () => {
    const log = new File(['csv'], 'lap.csv');
    api.getPathForFile(log);
    vi.mocked(runInEngine).mockResolvedValue({ name: 'lap' } as never);
    expect(await api.loadSource('lap.csv', 'racechrono')).toEqual({ name: 'lap' });
    expect(runInEngine).toHaveBeenCalledWith('loadSource', {
      path: 'lap.csv',
      kind: 'racechrono',
      file: log,
      subtitles: null,
    });
  });

  it('cannot load a file that was not picked in this tab', async () => {
    await expect(api.loadVideo('GX010082.MP4')).rejects.toThrow("'GX010082.MP4' is not open in this tab");
    expect(() => api.loadSource('lap.csv', 'racechrono')).toThrow("'lap.csv' is not open in this tab");
  });

  it('evaluates values in the engine', async () => {
    const project = createProject();
    vi.mocked(runInEngine).mockResolvedValue('snapshot' as never);
    expect(await api.evaluateValues(project, 30)).toBe('snapshot');
    expect(runInEngine).toHaveBeenCalledWith('evaluateValues', { project, frameRate: 30 });
  });
});

describe('projects', () => {
  const project = createProject({ name: 'Race' });

  it('opens a project picked with its media', async () => {
    const video = new File(['v'], 'GX010082.MP4');
    const picker = pickFiles(
      new File(['{}'], 'Race.track.json'),
      new File([serializeProject(project)], 'Race.overlay.json'),
      video,
    );
    const opened = await api.openProject();
    expect(opened?.path).toBe('Race.overlay.json');
    expect(opened?.project.name).toBe('Race');
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ id: 'project', multiple: true }));
    // The media picked with it are available to load.
    vi.mocked(runInEngine).mockResolvedValue({ info: {}, telemetry: null } as never);
    URL.createObjectURL = vi.fn(() => 'blob:video');
    await api.loadVideo('GX010082.MP4');
    expect(runInEngine).toHaveBeenCalledWith('loadVideo', expect.objectContaining({ file: video }));
  });

  it('takes any JSON file as the project, and needs one', async () => {
    pickFiles(new File([serializeProject(project)], 'race.json'));
    expect((await api.openProject())?.path).toBe('race.json');
    pickFiles(new File(['v'], 'GX010082.MP4'));
    await expect(api.openProject()).rejects.toThrow('Select the project file (*.overlay.json)');
    window.showOpenFilePicker = async () => {
      throw abortError();
    };
    expect(await api.openProject()).toBeNull();
  });

  it('saves a project named after it, and again to the same file', async () => {
    const file = saveTo('Race.overlay.json');
    expect(await api.saveProject(null, project)).toBe('Race.overlay.json');
    expect(window.showSaveFilePicker).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: 'Race.overlay.json' }),
    );
    expect(JSON.parse(await writtenText(file)).name).toBe('Race');
    expect(await api.saveProject('Race.overlay.json', { ...project, name: 'Race 2' })).toBe(
      'Race.overlay.json',
    );
    expect(window.showSaveFilePicker).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await writtenText(file)).name).toBe('Race 2');
  });

  it('suggests a file name for unnamed files', async () => {
    saveTo('x');
    await api.saveProject(null, { ...project, name: '  ' });
    expect(window.showSaveFilePicker).toHaveBeenLastCalledWith(
      expect.objectContaining({ suggestedName: 'project.overlay.json' }),
    );
  });
});

describe('templates, widgets, values and tracks', () => {
  it('saves and opens templates', async () => {
    const template = { ...createProject().template, name: 'Puma' };
    const file = saveTo('Puma.template.json');
    expect(await api.saveTemplate(template)).toBe('Puma.template.json');
    pickFiles(new File([await writtenText(file)], 'Puma.template.json'));
    expect(await api.openTemplate()).toEqual({ path: 'Puma.template.json', template });
  });

  it('saves a widget and opens widgets from widget or template files', async () => {
    const widget = createWidget('text', { name: 'Driver' });
    const file = saveTo('Driver.widget.json');
    await api.saveWidget(widget);
    expect(window.showSaveFilePicker).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: 'Driver.widget.json' }),
    );
    pickFiles(new File([await writtenText(file)], 'Driver.widget.json'));
    expect(await api.openWidgets()).toEqual([widget]);
    const template = { ...createProject().template, widgets: [widget, widget] };
    pickFiles(new File([serializeTemplate(template)], 'Puma.template.json'));
    expect(await api.openWidgets()).toHaveLength(2);
    window.showOpenFilePicker = async () => [];
    expect(await api.openWidgets()).toEqual([]);
  });

  it('saves and opens value scripts', async () => {
    const collection: ValueCollection = {
      version: 1,
      name: 'Laps',
      values: [
        {
          id: 'my.double',
          name: 'Double',
          description: '',
          unit: '',
          initial: null,
          code: 'return ctx.values.speed.map((v) => v * 2);',
        },
      ],
    };
    const file = saveTo('Laps.values.json');
    expect(await api.saveValueCollection(collection)).toBe('Laps.values.json');
    pickFiles(new File([await writtenText(file)], 'Laps.values.json'));
    expect((await api.openValueCollection())?.values.map((v) => v.id)).toEqual(['my.double']);
  });

  it('saves track lines and opens them from a track file or a project', async () => {
    const track: Track = TrackSchema.parse({ name: 'Guaporé' });
    const file = saveTo('Guaporé.track.json');
    await api.saveTrack(track);
    pickFiles(new File([await writtenText(file)], 'Guaporé.track.json'));
    expect(await api.openTrack()).toEqual(track);
    pickFiles(new File([serializeProject({ ...createProject(), track })], 'Race.overlay.json'));
    expect(await api.openTrack()).toEqual(track);
    window.showOpenFilePicker = async () => [];
    expect(await api.openTrack()).toBeNull();
    expect(await api.openTemplate()).toBeNull();
    expect(await api.openValueCollection()).toBeNull();
  });

  it('opens JSON files with a file input in other browsers', async () => {
    const template = createProject().template;
    mockFileInput([new File([serializeTemplate(template)], 't.template.json')]);
    expect((await api.openTemplate())?.template).toEqual(template);
  });
});

describe('track list', () => {
  const catalog = JSON.stringify(catalogFile);
  const respond = (body: string, ok = true) => vi.fn(async () => ({ ok, text: async () => body }));

  it('downloads the list once per tab and keeps it for offline starts', async () => {
    const fetch = respond(catalog);
    vi.stubGlobal('fetch', fetch);
    const first = await api.trackCatalog();
    expect(first?.source).toBe('github');
    expect(first?.tracks.map((t) => t.id)).toContain('br/guapore');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('catalog.json'),
      expect.objectContaining({ cache: 'no-cache' }),
    );
    await api.trackCatalog();
    expect(fetch).toHaveBeenCalledTimes(1);

    // Offline in a later tab: the last download.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline'))),
    );
    const offline = await (await freshApi()).trackCatalog();
    expect(offline).toMatchObject({ source: 'cache', fetchedAt: first?.fetchedAt });
    expect(offline?.tracks).toEqual(first?.tracks);
  });

  it('has no list without a download, and tries again later', async () => {
    const fetch = respond('nope', false);
    vi.stubGlobal('fetch', fetch);
    expect(await api.trackCatalog()).toBeNull();
    expect(await api.trackCatalog()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('ignores a broken download and a broken cache', async () => {
    localStorage.setItem('custom-overlay.tracks', '{broken');
    vi.stubGlobal('fetch', respond('{"not":"a catalog"}'));
    expect(await api.trackCatalog()).toBeNull();
  });

  it('works when the list cannot be stored', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.stubGlobal('fetch', respond(catalog));
    expect((await api.trackCatalog())?.source).toBe('github');
  });
});

describe('export', () => {
  const sequence = (outputPath: string | null = null): Project => {
    const project = createProject({ name: 'Race' });
    return { ...project, export: { ...project.export, mode: 'image-sequence', outputPath } };
  };
  const result = { outputPath: 'x', frames: 3, seconds: 1, encoder: null, workers: 1, warnings: [] };

  beforeEach(() => {
    vi.mocked(exportImageSequence).mockResolvedValue(result);
  });

  it('leaves the final video to the desktop app', async () => {
    expect(await api.selectOutput('video')).toBeNull();
    await expect(api.startExport(createProject())).rejects.toThrow('exported by the desktop app or the CLI');
    expect(exportImageSequence).not.toHaveBeenCalled();
  });

  it('downloads a zip in browsers without a folder picker', async () => {
    expect(await api.selectOutput('image-sequence')).toBe('frames');
    expect(await api.startExport(sequence('frames'))).toBe(result);
    expect(vi.mocked(exportImageSequence).mock.calls[0]?.[0].target.name).toBe('Race frames.zip');
  });

  it('writes into the folder chosen in the Export step', async () => {
    window.showDirectoryPicker = vi.fn(async () => folderHandle('Race frames'));
    await freshApi();
    expect(await api.selectOutput('image-sequence')).toBe('Race frames');
    await api.startExport(sequence('Race frames'));
    expect(vi.mocked(exportImageSequence).mock.calls[0]?.[0].target.name).toBe('Race frames');
    expect(window.showDirectoryPicker).toHaveBeenCalledTimes(1);
  });

  it('asks for the folder again when the project was reopened, and stops when refused', async () => {
    window.showDirectoryPicker = vi.fn(async () => folderHandle('Picked now'));
    await freshApi();
    await api.startExport(sequence('Race frames'));
    expect(vi.mocked(exportImageSequence).mock.calls[0]?.[0].target.name).toBe('Picked now');
    window.showDirectoryPicker = async () => {
      throw abortError();
    };
    await expect(api.startExport(sequence('Race frames'))).rejects.toThrow('Export cancelled');
  });

  it('runs one export at a time, reports its progress and cancels it', async () => {
    let finish: (value: typeof result) => void = () => undefined;
    vi.mocked(exportImageSequence).mockImplementation(
      (options) =>
        new Promise((resolve) => {
          options.onProgress({ frame: 1, frames: 3, fps: 10, elapsedSeconds: 0.1, etaSeconds: Number.NaN });
          finish = resolve;
        }),
    );
    const listener = vi.fn();
    const stop = api.onExportProgress(listener);
    const running = api.startExport(sequence('frames'));
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(expect.objectContaining({ frame: 1 })));
    await expect(api.startExport(sequence('frames'))).rejects.toThrow('An export is already running');
    const { signal } = vi.mocked(exportImageSequence).mock.calls[0]?.[0] ?? {};
    await api.cancelExport();
    expect(signal?.aborted).toBe(true);
    finish(result);
    await running;
    stop();
    // Done: another export can start, and the removed listener hears nothing.
    vi.mocked(exportImageSequence).mockImplementation(async (options) => {
      options.onProgress({ frame: 3, frames: 3, fps: 10, elapsedSeconds: 0.3, etaSeconds: 0 });
      return result;
    });
    await api.startExport(sequence('frames'));
    expect(listener).toHaveBeenCalledTimes(1);
    await expect(api.cancelExport()).resolves.toBeUndefined();
  });
});
