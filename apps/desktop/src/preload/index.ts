import type { AppApi } from '@custom-overlay/ui/api';
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IpcChannel } from '../shared/ipc';

const api: AppApi = {
  capabilities: { videoExport: true, revealFiles: true, sequenceAsZip: false },
  getLanguage: () => ipcRenderer.invoke(IpcChannel.getLanguage),
  setLanguage: (language) => ipcRenderer.invoke(IpcChannel.setLanguage, language),
  selectVideos: () => ipcRenderer.invoke(IpcChannel.selectVideos),
  withChapters: (selected, existing) => ipcRenderer.invoke(IpcChannel.withChapters, selected, existing),
  selectSources: () => ipcRenderer.invoke(IpcChannel.selectSources),
  detectSourceKind: (path) => ipcRenderer.invoke(IpcChannel.detectSourceKind, path),
  loadVideo: (path) => ipcRenderer.invoke(IpcChannel.loadVideo, path),
  loadSource: (path, kind) => ipcRenderer.invoke(IpcChannel.loadSource, path, kind),
  openProject: () => ipcRenderer.invoke(IpcChannel.openProject),
  getStartupProject: () => ipcRenderer.invoke(IpcChannel.startupProject),
  saveProject: (path, project) => ipcRenderer.invoke(IpcChannel.saveProject, path, project),
  openTemplate: () => ipcRenderer.invoke(IpcChannel.openTemplate),
  saveTemplate: (template) => ipcRenderer.invoke(IpcChannel.saveTemplate, template),
  selectOutput: (mode, defaultPath) => ipcRenderer.invoke(IpcChannel.selectOutput, mode, defaultPath),
  evaluateValues: (project, frameRate) => ipcRenderer.invoke(IpcChannel.evaluateValues, project, frameRate),
  openValueCollection: () => ipcRenderer.invoke(IpcChannel.openValueCollection),
  saveValueCollection: (collection) => ipcRenderer.invoke(IpcChannel.saveValueCollection, collection),
  openWidgets: () => ipcRenderer.invoke(IpcChannel.openWidgets),
  saveWidget: (widget) => ipcRenderer.invoke(IpcChannel.saveWidget, widget),
  startExport: (project) => ipcRenderer.invoke(IpcChannel.startExport, project),
  cancelExport: () => ipcRenderer.invoke(IpcChannel.cancelExport),
  onExportProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof listener>[0]) =>
      listener(progress);
    ipcRenderer.on(IpcChannel.exportProgress, handler);
    return () => ipcRenderer.removeListener(IpcChannel.exportProgress, handler);
  },
  revealPath: (path) => ipcRenderer.invoke(IpcChannel.revealPath, path),
  appInfo: () => ipcRenderer.invoke(IpcChannel.appInfo),
  checkForUpdate: () => ipcRenderer.invoke(IpcChannel.checkForUpdate),
  openProjectUrl: (url) => ipcRenderer.invoke(IpcChannel.openProjectUrl, url),
  openTrack: () => ipcRenderer.invoke(IpcChannel.openTrack),
  saveTrack: (track) => ipcRenderer.invoke(IpcChannel.saveTrack, track),
  trackCatalog: () => ipcRenderer.invoke(IpcChannel.trackCatalog),
  getPathForFile: (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('api', api);
