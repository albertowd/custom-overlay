import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { abortError, fileHandle, folderHandle, mockFileInput, mockLinkClicks } from './helpers';

type Files = typeof import('../../src/files');
let files: Files;

const json = { description: 'JSON', accept: { 'application/json': ['.json'] } };

beforeEach(async () => {
  // The registry and the handles are module state: a fresh copy per test.
  vi.resetModules();
  files = await import('../../src/files');
});

afterEach(() => {
  delete window.showOpenFilePicker;
  delete window.showSaveFilePicker;
  delete window.showDirectoryPicker;
  vi.restoreAllMocks();
});

describe('file registry', () => {
  it('names a stored path by its file name, whatever its separators', () => {
    expect(files.fileNameOf('../videos/GX010082.MP4')).toBe('GX010082.MP4');
    expect(files.fileNameOf('C:\\videos\\GX010082.MP4')).toBe('GX010082.MP4');
    expect(files.fileNameOf('GX010082.MP4')).toBe('GX010082.MP4');
  });

  it('finds files picked in this tab by the name of a stored path', () => {
    const video = new File(['v'], 'GX010082.MP4');
    expect(files.addFile(video)).toBe('GX010082.MP4');
    expect(files.fileAt('../videos/GX010082.MP4')).toBe(video);
    expect(files.knownFileNames()).toEqual(['GX010082.MP4']);
  });

  it('explains that a file of a stored path must be picked again', () => {
    expect(() => files.fileAt('D:\\old\\DJI_0001.MP4')).toThrow("'DJI_0001.MP4' is not open in this tab");
  });

  it('finds the subtitles picked with a video, in any case', () => {
    const subtitles = new File(['1'], 'dji_0001.SRT');
    files.addFile(new File(['v'], 'DJI_0001.MP4'));
    files.addFile(subtitles);
    expect(files.companionOf('DJI_0001.MP4', '.srt')).toBe(subtitles);
    expect(files.companionOf('DJI_0002.MP4', '.srt')).toBeNull();
  });
});

describe('opening files', () => {
  it('uses the File System Access picker and keeps the handles', async () => {
    const project = new File(['{}'], 'race.overlay.json');
    const picker = vi.fn(async () => [fileHandle(project)]);
    window.showOpenFilePicker = picker;
    expect(await files.openFiles('project', [json], true)).toEqual([project]);
    expect(picker).toHaveBeenCalledWith({ id: 'project', types: [json], multiple: true });
    expect(files.fileAt('race.overlay.json')).toBe(project);
  });

  it('opens nothing when the picker is dismissed, and reports other failures', async () => {
    window.showOpenFilePicker = async () => {
      throw abortError();
    };
    expect(await files.openFiles('media', [json])).toEqual([]);
    window.showOpenFilePicker = async () => {
      throw new Error('blocked');
    };
    await expect(files.openFiles('media', [json])).rejects.toThrow('blocked');
  });

  it('falls back to a file input in other browsers', async () => {
    const csv = new File(['x'], 'lap.csv');
    const input = mockFileInput([csv]);
    expect(
      await files.openFiles('media', [json, { description: 'CSV', accept: { 'text/csv': ['.csv'] } }], true),
    ).toEqual([csv]);
    expect(input().accept).toBe('.json,.csv');
    expect(input().multiple).toBe(true);
    expect(files.fileAt('lap.csv')).toBe(csv);
  });

  it('opens nothing when the file input is cancelled', async () => {
    mockFileInput(null);
    expect(await files.openFiles('media', [json])).toEqual([]);
  });
});

describe('saving files', () => {
  const save = (path: string | null = null) =>
    files.saveFile({ id: 'project', name: 'Race.overlay.json', type: json, text: '{"a":1}', path });

  it('writes again to a file opened before, when the browser allows it', async () => {
    const handle = fileHandle(new File(['{}'], 'race.overlay.json'));
    window.showOpenFilePicker = async () => [handle];
    await files.openFiles('project', [json]);
    window.showSaveFilePicker = vi.fn();
    expect(await save('race.overlay.json')).toBe('race.overlay.json');
    expect(await (handle.written[0] as Blob).text()).toBe('{"a":1}');
    expect(window.showSaveFilePicker).not.toHaveBeenCalled();
  });

  it('asks where to save when writing to the earlier file is refused', async () => {
    window.showOpenFilePicker = async () => [fileHandle(new File(['{}'], 'race.overlay.json'), 'denied')];
    await files.openFiles('project', [json]);
    const chosen = fileHandle(new File([], 'Copy.overlay.json'));
    window.showSaveFilePicker = vi.fn(async () => chosen);
    expect(await save('race.overlay.json')).toBe('Copy.overlay.json');
    expect(window.showSaveFilePicker).toHaveBeenCalledWith({
      id: 'project',
      suggestedName: 'Race.overlay.json',
      types: [json],
    });
    // The chosen file is written again next time without asking.
    expect(await save('Copy.overlay.json')).toBe('Copy.overlay.json');
    expect(window.showSaveFilePicker).toHaveBeenCalledTimes(1);
    expect(chosen.written).toHaveLength(2);
  });

  it('saves nothing when the save picker is dismissed', async () => {
    window.showSaveFilePicker = async () => {
      throw abortError();
    };
    expect(await save()).toBeNull();
    window.showSaveFilePicker = async () => {
      throw new Error('disk full');
    };
    await expect(save()).rejects.toThrow('disk full');
  });

  it('downloads the file in browsers without a save picker', async () => {
    const clicks = mockLinkClicks();
    expect(await save()).toBe('Race.overlay.json');
    expect(await save('C:\\projects\\race.overlay.json')).toBe('race.overlay.json');
    expect(clicks.map((link) => link.download)).toEqual(['Race.overlay.json', 'race.overlay.json']);
    expect(clicks[0]?.href).toMatch(/^blob:/);
  });
});

describe('export folders', () => {
  it('knows whether the browser can write into a folder', () => {
    expect(files.canPickFolder()).toBe(false);
    window.showDirectoryPicker = async () => folderHandle('frames');
    expect(files.canPickFolder()).toBe(true);
  });

  it('picks a folder to write into and finds it again by its name', async () => {
    expect(await files.pickFolder('export')).toBeNull();
    const folder = folderHandle('Race frames');
    const picker = vi.fn(async () => folder);
    window.showDirectoryPicker = picker;
    expect(await files.pickFolder('export')).toBe('Race frames');
    expect(picker).toHaveBeenCalledWith({ id: 'export', mode: 'readwrite' });
    expect(await files.writableFolder('D:\\exports\\Race frames')).toBe(folder);
    expect(await files.writableFolder('Other frames')).toBeNull();
  });

  it('needs write access to a picked folder', async () => {
    window.showDirectoryPicker = async () => folderHandle('frames', 'denied');
    await files.pickFolder('export');
    expect(await files.writableFolder('frames')).toBeNull();
  });

  it('picks no folder when the picker is dismissed', async () => {
    window.showDirectoryPicker = async () => {
      throw abortError();
    };
    expect(await files.pickFolder('export')).toBeNull();
    window.showDirectoryPicker = async () => {
      throw new Error('not allowed');
    };
    await expect(files.pickFolder('export')).rejects.toThrow('not allowed');
  });
});
