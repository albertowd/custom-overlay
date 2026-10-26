import type {
  CatalogTrack,
  DataRangeProblem,
  Project,
  SourceKind,
  TelemetrySeries,
  Template,
  Track,
  ValueCollection,
  ValueInfo,
  VersionChange,
  VideoInfo,
  Widget,
} from '@custom-overlay/core';
import type { ExportProgress, ExportResult } from '@custom-overlay/core/node';
import type { Language } from './i18n';

export interface LoadedVideoPayload {
  info: VideoInfo;
  telemetry: TelemetrySeries | null;
  /** URL the renderer can use as <video> src (served by the media:// protocol). */
  mediaUrl: string;
}

export interface SelectedSource {
  path: string;
  kind: SourceKind;
}

export interface OpenedProject {
  path: string;
  project: Project;
}

/** Every value of a project evaluated on a frame grid. */
export interface ValuesSnapshot {
  grid: { start: number; frameRate: number; count: number };
  values: ValueInfo[];
  /** One number per frame, by value id (the project's data range applied). */
  data: Record<string, Float64Array>;
  errors: Record<string, string>;
  /** Whole-session values (no data range) of positions and laps: Track map, range editors. */
  full: Record<string, Float64Array>;
  /** Values of the widgets with their own data range, by range key (`dataRangeKey`). */
  ranges: Record<string, Record<string, Float64Array>>;
  /** The project's data range in timeline seconds (null: the whole session) and its problems. */
  dataRange: { start: number; end: number } | null;
  dataRangeProblems: DataRangeProblem[];
}

/** The track list downloaded from the repository. */
export interface RemoteTrackCatalog {
  tracks: CatalogTrack[];
  /** Fresh from GitHub, or the last download (GitHub unreachable). */
  source: 'github' | 'cache';
  /** When it was downloaded (ISO 8601). */
  fetchedAt: string;
}

/** About this build of the app. */
export interface AppInfo {
  name: string;
  version: string;
  author: string;
  /** Project page (GitHub). */
  homepage: string;
}

/** A newer release on GitHub. */
export interface UpdateInfo {
  current: string;
  latest: string;
  /** What kind of step the update is. */
  change: VersionChange;
  title: string;
  /** Release notes (Markdown, shortened). */
  notes: string;
  pageUrl: string;
  /** Installer of this OS / architecture, null when the release has none. */
  downloadUrl: string | null;
  assetName: string | null;
}

/** What a host can do beyond the common API. */
export interface HostCapabilities {
  /** Renders final videos (ffmpeg); the web app leaves them to the desktop app or the CLI. */
  videoExport: boolean;
  /** Shows files in the system file manager. */
  revealFiles: boolean;
  /** Image sequences are downloaded as a zip: the browser cannot write into a folder. */
  sequenceAsZip: boolean;
}

/**
 * What the app needs from its host: the Electron main process (through the preload script) or
 * the browser (the web app).
 */
export interface AppApi {
  readonly capabilities: HostCapabilities;
  /** App language: the saved choice, else the best match for the system languages. */
  getLanguage(): Promise<Language>;
  /** Save the app language. Chromium's own texts follow it after a restart. */
  setLanguage(language: Language): Promise<void>;
  selectVideos(): Promise<string[]>;
  /**
   * Videos to add for a selection: asks whether to add the other chapters of selected GoPro
   * recordings (in recording order) and skips videos already in the project.
   */
  withChapters(selected: string[], existing: string[]): Promise<string[]>;
  selectSources(): Promise<SelectedSource[]>;
  /** Detect the kind of a dropped file, null when unsupported. */
  detectSourceKind(path: string): Promise<SourceKind | null>;
  loadVideo(path: string): Promise<LoadedVideoPayload>;
  loadSource(path: string, kind: SourceKind): Promise<TelemetrySeries>;
  openProject(): Promise<OpenedProject | null>;
  /** Project file passed on the command line (e.g. "open with"), if any. */
  getStartupProject(): Promise<OpenedProject | null>;
  /** Save to `path`, or ask for a location when null. Returns the saved path, null if cancelled. */
  saveProject(path: string | null, project: Project): Promise<string | null>;
  openTemplate(): Promise<{ path: string; template: Template } | null>;
  saveTemplate(template: Template): Promise<string | null>;
  /** Ask where to export, starting at `defaultPath` (file or folder) when given. */
  selectOutput(mode: Project['export']['mode'], defaultPath?: string | null): Promise<string | null>;
  /** Evaluate the project values (scripts run in the main process). Media must be loaded first. */
  evaluateValues(project: Project, frameRate: number): Promise<ValuesSnapshot>;
  openValueCollection(): Promise<ValueCollection | null>;
  saveValueCollection(collection: ValueCollection): Promise<string | null>;
  /** Widgets from a widget file or a template file (empty when cancelled). */
  openWidgets(): Promise<Widget[]>;
  saveWidget(widget: Widget): Promise<string | null>;
  /** Track lines from a track file or another project, null when cancelled. */
  openTrack(): Promise<Track | null>;
  saveTrack(track: Track): Promise<string | null>;
  /** The latest track list from GitHub (or its last download), null when never downloaded. */
  trackCatalog(): Promise<RemoteTrackCatalog | null>;
  /** Render the export with the project's export settings; rejects when cancelled or failed. */
  startExport(project: Project): Promise<ExportResult>;
  cancelExport(): Promise<void>;
  /** Listen to export progress; returns a function that stops listening. */
  onExportProgress(listener: (progress: ExportProgress) => void): () => void;
  /** Show a file or folder in the system file manager. */
  revealPath(path: string): Promise<void>;
  appInfo(): Promise<AppInfo>;
  /** The latest GitHub release when it is newer than this app (null offline or up to date). */
  checkForUpdate(): Promise<UpdateInfo | null>;
  /** Open a page of the project on GitHub (release, download) in the browser. */
  openProjectUrl(url: string): Promise<void>;
  /** Path that stands for a dropped File: absolute on the desktop, the file name on the web. */
  getPathForFile(file: File): string;
}
