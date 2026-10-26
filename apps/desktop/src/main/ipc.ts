import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  goproChapterFiles,
  PROJECT_FILE_EXTENSION,
  type Project,
  type SourceKind,
  type Template,
  TRACK_FILE_EXTENSION,
  type Track,
  VALUES_FILE_EXTENSION,
  type ValueCollection,
  WIDGET_FILE_EXTENSION,
  type Widget,
} from '@custom-overlay/core';
import {
  detectSourceKind,
  loadSourceFile,
  loadVideo,
  readProjectFile,
  readTemplateFile,
  readTrack,
  readValueCollection,
  readWidgets,
  writeProjectFile,
  writeTemplateFile,
  writeTrackFile,
  writeValueCollection,
  writeWidgetFile,
} from '@custom-overlay/core/node';
import type { LoadedVideoPayload, SelectedSource } from '@custom-overlay/ui/api';
import { evaluateProjectValues, rememberSource, rememberVideo } from '@custom-overlay/ui/host';
import { isLanguage } from '@custom-overlay/ui/i18n';
import { BrowserWindow, dialog, type IpcMainInvokeEvent, ipcMain, shell } from 'electron';
import { IpcChannel } from '../shared/ipc';
import { cancelExport, startExport } from './export';
import { mediaUrlFor } from './media-protocol';
import { type FolderKind, getLanguage, rememberFolder, setLanguage, startFolder, t } from './settings';
import { remoteTrackCatalog } from './tracks';
import { appInfo, checkForUpdate, isProjectUrl } from './updates';

// Functions, not constants: the names follow the current app language.
const videoFilters = () => [{ name: t('main.filters.videos'), extensions: ['mp4', 'MP4', 'mov', 'MOV'] }];
const sourceFilters = () => [
  { name: t('main.filters.telemetry'), extensions: ['csv', 'CSV', 'srt', 'SRT', 'mp4', 'MP4', 'mov', 'MOV'] },
  { name: 'RaceChrono CSV', extensions: ['csv', 'CSV'] },
  { name: t('main.filters.djiSubtitles'), extensions: ['srt', 'SRT'] },
  { name: t('main.filters.videoTelemetry'), extensions: ['mp4', 'MP4', 'mov', 'MOV'] },
];
const projectFilters = () => [{ name: t('main.filters.project'), extensions: ['overlay.json', 'json'] }];
const valuesFilters = () => [{ name: t('main.filters.values'), extensions: ['values.json', 'json'] }];
const trackFilters = () => [
  { name: t('main.filters.trackOrProject'), extensions: ['track.json', 'overlay.json', 'json'] },
];
const widgetFilters = () => [
  { name: t('main.filters.widgets'), extensions: ['widget.json', 'template.json', 'json'] },
];
const templateFilters = () => [{ name: t('main.filters.template'), extensions: ['template.json', 'json'] }];

function windowOf(event: IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) throw new Error('No window for this request');
  return window;
}

const samePath = (path: string) => resolve(path).toLowerCase();

/**
 * Videos to add for a selection. When a selected video is one chapter of a GoPro recording and
 * other chapters sit in its folder, ask once whether to add the whole recordings: each one then
 * replaces its selected chapter, in recording order. Videos already in the project are skipped.
 */
async function withChapters(
  event: IpcMainInvokeEvent,
  selected: string[],
  existing: string[],
): Promise<string[]> {
  const known = new Set([...selected, ...existing].map(samePath));
  const recordings = new Map<string, string[]>();
  for (const path of selected) {
    const names = await readdir(dirname(path)).catch(() => [] as string[]);
    const chapters = goproChapterFiles(path, names);
    if (chapters.some((c) => !known.has(samePath(c)))) recordings.set(samePath(path), chapters);
  }
  const inProject = new Set(existing.map(samePath));
  const fresh = (paths: string[]) => [...new Set(paths)].filter((p) => !inProject.has(samePath(p)));
  if (recordings.size === 0) return fresh(selected);

  const whole = [...new Map([...recordings.values()].map((c) => [c[0], c])).values()];
  const missing = new Set(whole.flat().filter((c) => !known.has(samePath(c))));
  const { response } = await dialog.showMessageBox(windowOf(event), {
    type: 'question',
    title: t('main.chapters.title'),
    message: t('main.chapters.message', { count: whole.length }),
    detail: [
      t('main.chapters.explanation'),
      ...whole.map(
        (c) =>
          `  ${basename(c[0] as string)} … ${basename(c[c.length - 1] as string)} (${t('main.chapters.files', { count: c.length })})`,
      ),
      '',
      t('main.chapters.question', { count: missing.size }),
    ].join('\n'),
    buttons: [t('main.chapters.addAll'), t('main.chapters.onlySelected')],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return fresh(selected);
  return fresh(selected.flatMap((path) => recordings.get(samePath(path)) ?? [path]));
}

/** Ask for files to open, starting where files of that kind were last picked. */
async function openFile(
  event: IpcMainInvokeEvent,
  kind: FolderKind,
  title: string,
  filters: Electron.FileFilter[],
  multiple = false,
): Promise<string[]> {
  const result = await dialog.showOpenDialog(windowOf(event), {
    title,
    filters,
    defaultPath: startFolder(kind),
    properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return [];
  rememberFolder(kind, result.filePaths[0]);
  return result.filePaths;
}

/**
 * Ask where to save a file, suggesting `name` in `folder` or where files of that kind were last
 * picked. A bare name would make Windows start in the app's working folder every time.
 */
async function saveFile(
  event: IpcMainInvokeEvent,
  kind: FolderKind,
  options: { title: string; name: string; filters: Electron.FileFilter[]; folder?: string | null },
): Promise<string | null> {
  const result = await dialog.showSaveDialog(windowOf(event), {
    title: options.title,
    defaultPath: join(options.folder ?? startFolder(kind), options.name),
    filters: options.filters,
  });
  if (result.canceled || !result.filePath) return null;
  rememberFolder(kind, result.filePath);
  return result.filePath;
}

/** `text` without trailing `chars` (a loop: `/[. ]+$/` backtracks quadratically on long runs). */
function trimEndOf(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text.charAt(end - 1))) end--;
  return text.slice(0, end);
}

/** A name typed by the user as a suggested file name: characters Windows forbids become '_'. */
function fileName(name: string, fallback: string): string {
  const FORBIDDEN = '<>:"/\\|?*';
  const safe = trimEndOf(
    Array.from(name, (c) => (c < ' ' || FORBIDDEN.includes(c) ? '_' : c)).join(''),
    '. ',
  ).trim();
  return safe || fallback;
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannel.getLanguage, () => getLanguage());
  ipcMain.handle(IpcChannel.setLanguage, (_event, language: unknown) => {
    if (!isLanguage(language)) throw new Error(`Unsupported language: ${String(language)}`);
    setLanguage(language);
  });
  ipcMain.handle(IpcChannel.selectVideos, (event) =>
    openFile(event, 'media', t('main.dialogs.addVideos'), videoFilters(), true),
  );

  ipcMain.handle(IpcChannel.withChapters, (event, selected: string[], existing: string[]) =>
    withChapters(event, selected, existing),
  );

  ipcMain.handle(IpcChannel.selectSources, async (event): Promise<SelectedSource[]> => {
    const paths = await openFile(event, 'media', t('main.dialogs.addSources'), sourceFilters(), true);
    return paths.flatMap((path) => {
      const kind = detectSourceKind(path);
      return kind ? [{ path, kind }] : [];
    });
  });

  ipcMain.handle(IpcChannel.detectSourceKind, (_event, path: string) => detectSourceKind(path));

  ipcMain.handle(IpcChannel.loadVideo, async (_event, path: string): Promise<LoadedVideoPayload> => {
    const video = await loadVideo(path);
    rememberVideo(path, video.info, video.telemetry);
    return { ...video, mediaUrl: mediaUrlFor(path) };
  });

  ipcMain.handle(IpcChannel.loadSource, async (_event, path: string, kind: SourceKind) => {
    const series = await loadSourceFile(path, kind);
    rememberSource(path, kind, series);
    return series;
  });

  ipcMain.handle(IpcChannel.startExport, (event, project: Project) => startExport(event.sender, project));
  ipcMain.handle(IpcChannel.cancelExport, () => cancelExport());
  ipcMain.handle(IpcChannel.revealPath, (_event, path: string) => shell.showItemInFolder(path));
  ipcMain.handle(IpcChannel.appInfo, () => appInfo());
  ipcMain.handle(IpcChannel.checkForUpdate, () => checkForUpdate());
  ipcMain.handle(IpcChannel.openProjectUrl, async (_event, url: string) => {
    if (!isProjectUrl(url)) throw new Error('Only pages of the project can be opened');
    await shell.openExternal(url);
  });

  ipcMain.handle(IpcChannel.evaluateValues, (_event, project: Project, frameRate: number) =>
    evaluateProjectValues(project, frameRate),
  );

  ipcMain.handle(IpcChannel.openWidgets, async (event) => {
    const [path] = await openFile(event, 'widget', t('main.dialogs.importWidgets'), widgetFilters());
    return path ? readWidgets(path) : [];
  });

  ipcMain.handle(IpcChannel.saveWidget, async (event, widget: Widget) => {
    const path = await saveFile(event, 'widget', {
      title: t('main.dialogs.exportWidget'),
      name: `${fileName(widget.name, widget.type)}${WIDGET_FILE_EXTENSION}`,
      filters: [{ name: t('main.filters.widget'), extensions: ['widget.json'] }],
    });
    if (path) await writeWidgetFile(path, widget);
    return path;
  });

  ipcMain.handle(IpcChannel.openTrack, async (event) => {
    const [path] = await openFile(event, 'track', t('main.dialogs.importTrack'), trackFilters());
    return path ? readTrack(path) : null;
  });

  ipcMain.handle(IpcChannel.saveTrack, async (event, track: Track) => {
    const path = await saveFile(event, 'track', {
      title: t('main.dialogs.exportTrack'),
      name: `${fileName(track.name, 'track')}${TRACK_FILE_EXTENSION}`,
      filters: [{ name: t('main.filters.track'), extensions: ['track.json'] }],
    });
    if (path) await writeTrackFile(path, track);
    return path;
  });

  ipcMain.handle(IpcChannel.trackCatalog, () => remoteTrackCatalog());

  ipcMain.handle(IpcChannel.openValueCollection, async (event) => {
    const [path] = await openFile(event, 'values', t('main.dialogs.importValues'), valuesFilters());
    return path ? readValueCollection(path) : null;
  });

  ipcMain.handle(IpcChannel.saveValueCollection, async (event, collection: ValueCollection) => {
    const path = await saveFile(event, 'values', {
      title: t('main.dialogs.exportValues'),
      name: `${fileName(collection.name, 'values')}${VALUES_FILE_EXTENSION}`,
      filters: valuesFilters(),
    });
    if (path) await writeValueCollection(path, collection);
    return path;
  });

  ipcMain.handle(IpcChannel.openProject, async (event) => {
    const [path] = await openFile(event, 'project', t('main.dialogs.openProject'), projectFilters());
    if (!path) return null;
    return { path, project: await readProjectFile(path) };
  });

  ipcMain.handle(IpcChannel.startupProject, async () => {
    const path = process.argv.find((arg) => arg.toLowerCase().endsWith(PROJECT_FILE_EXTENSION));
    if (!path || !existsSync(path)) return null;
    return { path: resolve(path), project: await readProjectFile(path) };
  });

  ipcMain.handle(IpcChannel.saveProject, async (event, path: string | null, project: Project) => {
    let target = path;
    if (!target) {
      // A new project is suggested next to its media: its paths are stored relative to it.
      const media = project.videos[0]?.path ?? project.sources[0]?.path;
      target = await saveFile(event, 'project', {
        title: t('main.dialogs.saveProject'),
        name: `${fileName(project.name, 'project')}${PROJECT_FILE_EXTENSION}`,
        filters: projectFilters(),
        folder: media && existsSync(dirname(media)) ? dirname(media) : null,
      });
      if (!target) return null;
    }
    await writeProjectFile(target, project);
    return target;
  });

  ipcMain.handle(IpcChannel.openTemplate, async (event) => {
    const [path] = await openFile(event, 'template', t('main.dialogs.loadTemplate'), templateFilters());
    if (!path) return null;
    return { path, template: await readTemplateFile(path) };
  });

  ipcMain.handle(IpcChannel.saveTemplate, async (event, template: Template) => {
    const path = await saveFile(event, 'template', {
      title: t('main.dialogs.saveTemplate'),
      name: `${fileName(template.name, 'template')}.template.json`,
      filters: templateFilters(),
    });
    if (path) await writeTemplateFile(path, template);
    return path;
  });

  ipcMain.handle(
    IpcChannel.selectOutput,
    async (event, mode: Project['export']['mode'], defaultPath?: string | null) => {
      const window = windowOf(event);
      if (mode === 'image-sequence') {
        const result = await dialog.showOpenDialog(window, {
          title: t('main.dialogs.outputFolder'),
          // The folder holding the default (it may not exist yet).
          defaultPath: defaultPath ? dirname(defaultPath) : startFolder('media'),
          properties: ['openDirectory', 'createDirectory'],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      }
      const result = await dialog.showSaveDialog(window, {
        title: t('main.dialogs.exportVideo'),
        defaultPath: defaultPath ?? join(startFolder('media'), 'overlay.mp4'),
        filters: [{ name: t('main.filters.mp4'), extensions: ['mp4'] }],
      });
      return result.canceled || !result.filePath ? null : result.filePath;
    },
  );
}
