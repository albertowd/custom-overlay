import {
  detectSourceKind,
  goproChapterFiles,
  PROJECT_FILE_EXTENSION,
  type Project,
  parseProject,
  parseTemplate,
  parseTrackCatalog,
  parseValueCollection,
  serializeProject,
  serializeTemplate,
  serializeTrackFile,
  serializeValueCollection,
  serializeWidgetFile,
  TEMPLATE_FILE_EXTENSION,
  TRACK_CATALOG_URL,
  TRACK_FILE_EXTENSION,
  trackFromData,
  VALUES_FILE_EXTENSION,
  WIDGET_FILE_EXTENSION,
  widgetsFromData,
} from '@custom-overlay/core';
import type { ExportProgress } from '@custom-overlay/core/node';
import { t } from '@custom-overlay/ui';
import type { AppApi, RemoteTrackCatalog } from '@custom-overlay/ui/api';
import { isLanguage, type Language, matchLanguage } from '@custom-overlay/ui/i18n';
import pkg from '../package.json';
import { runInEngine } from './engine';
import { exportImageSequence, folderTarget, type SequenceTarget, zipTarget } from './export';
import {
  addFile,
  canPickFolder,
  companionOf,
  type FileType,
  fileAt,
  fileNameOf,
  openFiles,
  type PickerId,
  pickFolder,
  saveFile,
  writableFolder,
} from './files';

const REPOSITORY = 'albertowd/custom-overlay';
const LANGUAGE_KEY = 'custom-overlay.language';
const CATALOG_KEY = 'custom-overlay.tracks';

// Functions, not constants: the descriptions follow the current app language.
const VIDEO_ACCEPT = { 'video/mp4': ['.mp4'], 'video/quicktime': ['.mov'] };
const TELEMETRY_ACCEPT = { 'text/csv': ['.csv'], 'application/x-subrip': ['.srt'], ...VIDEO_ACCEPT };
const JSON_ACCEPT = { 'application/json': ['.json'] };
const videoType = (): FileType => ({ description: t('main.filters.videos'), accept: VIDEO_ACCEPT });
const sourceType = (): FileType => ({ description: t('main.filters.telemetry'), accept: TELEMETRY_ACCEPT });
const jsonType = (key: string): FileType => ({ description: t(`main.filters.${key}`), accept: JSON_ACCEPT });

/** Parsed contents of a JSON file to open (null when cancelled). */
async function openJson(id: PickerId, type: FileType): Promise<{ path: string; data: unknown } | null> {
  const [file] = await openFiles(id, [type]);
  return file ? { path: file.name, data: JSON.parse(await file.text()) } : null;
}

/** A name typed by the user as a suggested file name (the browser makes it safe). */
const fileName = (name: string, fallback: string) => name.trim() || fallback;

/** Object URLs of the videos for <video>, one per file. */
const mediaUrls = new WeakMap<File, string>();

function mediaUrlOf(file: File): string {
  let url = mediaUrls.get(file);
  if (!url) {
    url = URL.createObjectURL(file);
    mediaUrls.set(file, url);
  }
  return url;
}

const sameFile = (path: string) => fileNameOf(path).toLowerCase();

/**
 * Videos to add for a selection, without those already in the project. The browser cannot look
 * into a folder, so chapters of a GoPro recording are only put in recording order when they
 * were selected together.
 */
function withChapters(selected: string[], existing: string[]): string[] {
  const names = selected.map(fileNameOf);
  const inProject = new Set(existing.map(sameFile));
  const ordered = selected.flatMap((path) => {
    const chapters = goproChapterFiles(path, names);
    return chapters.length > 0 ? chapters : [path];
  });
  return [...new Set(ordered)].filter((path) => !inProject.has(sameFile(path)));
}

let catalog: Promise<RemoteTrackCatalog | null> | null = null;

async function downloadCatalog(): Promise<RemoteTrackCatalog | null> {
  try {
    // The browser revalidates its HTTP cache with the ETag.
    const response = await fetch(TRACK_CATALOG_URL, {
      cache: 'no-cache',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      const text = await response.text();
      const tracks = parseTrackCatalog(JSON.parse(text));
      const fetchedAt = new Date().toISOString();
      try {
        localStorage.setItem(CATALOG_KEY, JSON.stringify({ fetchedAt, catalog: text }));
      } catch {
        // Storage unavailable or full: the next start downloads it again.
      }
      return { tracks, source: 'github', fetchedAt };
    }
  } catch {
    // Offline, GitHub unreachable or a broken file: fall back to the last download.
  }
  try {
    const cached = JSON.parse(localStorage.getItem(CATALOG_KEY) ?? 'null') as {
      fetchedAt: string;
      catalog: string;
    } | null;
    if (!cached) return null;
    return {
      tracks: parseTrackCatalog(JSON.parse(cached.catalog)),
      source: 'cache',
      fetchedAt: cached.fetchedAt,
    };
  } catch {
    return null;
  }
}

/** The export running, to cancel it. */
let running: AbortController | null = null;
const progressListeners = new Set<(progress: ExportProgress) => void>();

/**
 * Where an image sequence goes: the folder chosen in the Export step, else one picked now (the
 * folder of a reopened project must be picked again), else a zip download.
 */
async function sequenceTarget(project: Project): Promise<SequenceTarget | null> {
  if (!canPickFolder()) return zipTarget(project);
  const chosen = project.export.outputPath && (await writableFolder(project.export.outputPath));
  if (chosen) return folderTarget(chosen);
  const name = await pickFolder('export');
  const folder = name && (await writableFolder(name));
  return folder ? folderTarget(folder) : null;
}

/** `AppApi` in a browser: files come from pickers and drops, the engine runs in a worker. */
export const webApi: AppApi = {
  capabilities: { videoExport: false, revealFiles: false, sequenceAsZip: !canPickFolder() },
  async getLanguage() {
    try {
      const saved = localStorage.getItem(LANGUAGE_KEY);
      if (isLanguage(saved)) return saved;
    } catch {
      // Storage unavailable: follow the browser languages.
    }
    return matchLanguage(navigator.languages);
  },

  async setLanguage(language: Language) {
    try {
      localStorage.setItem(LANGUAGE_KEY, language);
    } catch {
      // Storage unavailable: the choice lasts for this tab.
    }
  },

  async selectVideos() {
    return (await openFiles('media', [videoType()], true)).map((file) => file.name);
  },

  async withChapters(selected, existing) {
    return withChapters(selected, existing);
  },

  async selectSources() {
    const files = await openFiles('media', [sourceType()], true);
    return files.flatMap((file) => {
      const kind = detectSourceKind(file.name);
      return kind ? [{ path: file.name, kind }] : [];
    });
  },

  async detectSourceKind(path) {
    return detectSourceKind(path);
  },

  async loadVideo(path) {
    const file = fileAt(path);
    const video = await runInEngine('loadVideo', { path, file, subtitles: companionOf(path, '.srt') });
    return { ...video, mediaUrl: mediaUrlOf(file) };
  },

  loadSource(path, kind) {
    return runInEngine('loadSource', {
      path,
      kind,
      file: fileAt(path),
      subtitles: companionOf(path, '.srt'),
    });
  },

  async openProject() {
    // The browser cannot reach the project's media on its own: they are picked with it.
    const files = await openFiles(
      'project',
      [{ description: t('web.filters.projectWithMedia'), accept: { ...JSON_ACCEPT, ...TELEMETRY_ACCEPT } }],
      true,
    );
    if (files.length === 0) return null;
    const json = files.filter((file) => file.name.toLowerCase().endsWith('.json'));
    const file = json.find((f) => f.name.toLowerCase().endsWith(PROJECT_FILE_EXTENSION)) ?? json[0];
    if (!file) throw new Error(t('web.files.noProject'));
    return { path: file.name, project: parseProject(JSON.parse(await file.text())) };
  },

  async getStartupProject() {
    return null;
  },

  saveProject(path, project) {
    return saveFile({
      id: 'project',
      name: `${fileName(project.name, 'project')}${PROJECT_FILE_EXTENSION}`,
      type: jsonType('project'),
      text: serializeProject(project),
      path,
    });
  },

  async openTemplate() {
    const opened = await openJson('template', jsonType('template'));
    return opened && { path: opened.path, template: parseTemplate(opened.data) };
  },

  saveTemplate(template) {
    return saveFile({
      id: 'template',
      name: `${fileName(template.name, 'template')}${TEMPLATE_FILE_EXTENSION}`,
      type: jsonType('template'),
      text: serializeTemplate(template),
    });
  },

  async selectOutput(mode) {
    // Videos are exported by the desktop app or the CLI, which choose their output.
    if (mode === 'video') return null;
    // Without a folder picker the frames are downloaded as a zip: the name only marks the choice.
    return canPickFolder() ? pickFolder('export') : 'frames';
  },

  evaluateValues(project, frameRate) {
    return runInEngine('evaluateValues', { project, frameRate });
  },

  async openValueCollection() {
    const opened = await openJson('values', jsonType('values'));
    return opened && parseValueCollection(opened.data);
  },

  saveValueCollection(collection) {
    return saveFile({
      id: 'values',
      name: `${fileName(collection.name, 'values')}${VALUES_FILE_EXTENSION}`,
      type: jsonType('values'),
      text: serializeValueCollection(collection),
    });
  },

  async openWidgets() {
    const opened = await openJson('widget', jsonType('widgets'));
    return opened ? widgetsFromData(opened.data) : [];
  },

  saveWidget(widget) {
    return saveFile({
      id: 'widget',
      name: `${fileName(widget.name, widget.type)}${WIDGET_FILE_EXTENSION}`,
      type: jsonType('widget'),
      text: serializeWidgetFile({ version: 1, widget }),
    });
  },

  async openTrack() {
    const opened = await openJson('track', jsonType('trackOrProject'));
    return opened && trackFromData(opened.data);
  },

  saveTrack(track) {
    return saveFile({
      id: 'track',
      name: `${fileName(track.name, 'track')}${TRACK_FILE_EXTENSION}`,
      type: jsonType('track'),
      text: serializeTrackFile({ version: 1, track }),
    });
  },

  trackCatalog() {
    catalog ??= downloadCatalog().then((result) => {
      // Downloaded once per tab; a failed attempt is retried on the next call.
      if (!result || result.source === 'cache') catalog = null;
      return result;
    });
    return catalog;
  },

  async startExport(project) {
    if (project.export.mode === 'video') throw new Error(t('core.issues.videoExportElsewhere'));
    if (running) throw new Error('An export is already running');
    const target = await sequenceTarget(project);
    if (!target) throw new Error('Export cancelled');
    running = new AbortController();
    try {
      return await exportImageSequence({
        project,
        target,
        signal: running.signal,
        onProgress: (progress) => {
          for (const listener of progressListeners) listener(progress);
        },
      });
    } finally {
      running = null;
    }
  },

  async cancelExport() {
    running?.abort();
  },

  onExportProgress(listener) {
    progressListeners.add(listener);
    return () => {
      progressListeners.delete(listener);
    };
  },

  // The export result names a folder or a download: nothing to show.
  async revealPath() {
    // A browser cannot show files in the system file manager.
  },

  async appInfo() {
    return {
      name: 'Custom Overlay',
      version: pkg.version,
      author: pkg.author,
      homepage: `https://github.com/${REPOSITORY}`,
    };
  },

  async checkForUpdate() {
    // The service worker installs new versions of the web app.
    return null;
  },

  async openProjectUrl(url) {
    if (!url.startsWith(`https://github.com/${REPOSITORY}`))
      throw new Error('Only pages of the project can be opened');
    window.open(url, '_blank', 'noopener');
  },

  getPathForFile(file) {
    return addFile(file);
  },
};
