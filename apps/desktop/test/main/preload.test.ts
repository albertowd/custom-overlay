import { createProject, createTemplate } from '@custom-overlay/core';
import type { AppApi } from '@custom-overlay/ui/api';
import { describe, expect, it, vi } from 'vitest';
import { IpcChannel } from '../../src/shared/ipc';
import { contextBridge, ipcRenderer, webUtils } from './electron-mock';

vi.mock('electron', () => import('./electron-mock'));

await import('../../src/preload/index');

const [name, exposed] = contextBridge.exposeInMainWorld.mock.calls[0] ?? [];
const api = exposed as AppApi;

const project = createProject();
const template = createTemplate();
const widget = template.widgets[0] ?? ({ id: 'w' } as never);
const track = { name: 'Track' } as never;
const collection = { name: 'values' } as never;

/** Every request of the API, called with sample arguments, and what it sends to the main process. */
const requests: [string, () => Promise<unknown>, string, unknown[]][] = [
  ['getLanguage', () => api.getLanguage(), IpcChannel.getLanguage, []],
  ['setLanguage', () => api.setLanguage('ja'), IpcChannel.setLanguage, ['ja']],
  ['selectVideos', () => api.selectVideos(), IpcChannel.selectVideos, []],
  ['withChapters', () => api.withChapters(['/a'], ['/b']), IpcChannel.withChapters, [['/a'], ['/b']]],
  ['selectSources', () => api.selectSources(), IpcChannel.selectSources, []],
  ['detectSourceKind', () => api.detectSourceKind('/a.csv'), IpcChannel.detectSourceKind, ['/a.csv']],
  ['loadVideo', () => api.loadVideo('/a.mp4'), IpcChannel.loadVideo, ['/a.mp4']],
  [
    'loadSource',
    () => api.loadSource('/a.csv', 'racechrono'),
    IpcChannel.loadSource,
    ['/a.csv', 'racechrono'],
  ],
  ['openProject', () => api.openProject(), IpcChannel.openProject, []],
  ['getStartupProject', () => api.getStartupProject(), IpcChannel.startupProject, []],
  [
    'saveProject',
    () => api.saveProject('/p.overlay.json', project),
    IpcChannel.saveProject,
    ['/p.overlay.json', project],
  ],
  ['openTemplate', () => api.openTemplate(), IpcChannel.openTemplate, []],
  ['saveTemplate', () => api.saveTemplate(template), IpcChannel.saveTemplate, [template]],
  ['selectOutput', () => api.selectOutput('video', '/o.mp4'), IpcChannel.selectOutput, ['video', '/o.mp4']],
  ['evaluateValues', () => api.evaluateValues(project, 30), IpcChannel.evaluateValues, [project, 30]],
  ['openValueCollection', () => api.openValueCollection(), IpcChannel.openValueCollection, []],
  [
    'saveValueCollection',
    () => api.saveValueCollection(collection),
    IpcChannel.saveValueCollection,
    [collection],
  ],
  ['openWidgets', () => api.openWidgets(), IpcChannel.openWidgets, []],
  ['saveWidget', () => api.saveWidget(widget), IpcChannel.saveWidget, [widget]],
  ['startExport', () => api.startExport(project), IpcChannel.startExport, [project]],
  ['cancelExport', () => api.cancelExport(), IpcChannel.cancelExport, []],
  ['revealPath', () => api.revealPath('/o.mp4'), IpcChannel.revealPath, ['/o.mp4']],
  ['appInfo', () => api.appInfo(), IpcChannel.appInfo, []],
  ['checkForUpdate', () => api.checkForUpdate(), IpcChannel.checkForUpdate, []],
  ['openProjectUrl', () => api.openProjectUrl('https://x'), IpcChannel.openProjectUrl, ['https://x']],
  ['openTrack', () => api.openTrack(), IpcChannel.openTrack, []],
  ['saveTrack', () => api.saveTrack(track), IpcChannel.saveTrack, [track]],
  ['trackCatalog', () => api.trackCatalog(), IpcChannel.trackCatalog, []],
];

describe('preload', () => {
  it('exposes the API as window.api', () => {
    expect(name).toBe('api');
    const covered = new Set([
      ...requests.map(([method]) => method),
      'onExportProgress',
      'getPathForFile',
      'capabilities',
    ]);
    expect(Object.keys(api).sort()).toEqual([...covered].sort());
  });

  it('declares what the desktop app can do', () => {
    expect(api.capabilities).toEqual({ videoExport: true, revealFiles: true, sequenceAsZip: false });
  });

  it.each(requests)('%s invokes its channel', async (_method, call, channel, args) => {
    ipcRenderer.invoke.mockResolvedValueOnce('answer');
    expect(await call()).toBe('answer');
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith(channel, ...args);
  });

  it('forwards export progress until the listener is removed', () => {
    const listener = vi.fn();
    const stop = api.onExportProgress(listener);
    const [channel, handler] = ipcRenderer.on.mock.calls.at(-1) ?? [];
    expect(channel).toBe(IpcChannel.exportProgress);
    const progress = { frame: 3, frames: 9 };
    (handler as (event: unknown, progress: unknown) => void)({}, progress);
    expect(listener).toHaveBeenCalledWith(progress);

    stop();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(IpcChannel.exportProgress, handler);
  });

  it('resolves the path of a dropped file', () => {
    const file = { name: 'clip.mp4' } as File;
    expect(api.getPathForFile(file)).toBe('/picked/clip.mp4');
    expect(webUtils.getPathForFile).toHaveBeenCalledWith(file);
  });
});
