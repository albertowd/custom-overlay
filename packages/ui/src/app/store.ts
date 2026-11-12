import {
  type AlignEdge,
  type AlignReference,
  AUTO_SYNC_MIN_CONFIDENCE,
  addSource,
  addVideo,
  alignWidgets,
  applyPreset,
  applySyncResult,
  autoSyncItem,
  autoSyncProject,
  bestTrackMatch,
  boundsCentre,
  boundsOf,
  type CatalogTrack,
  cleanGroups as cleanGroupsOf,
  computeTimeline,
  createId,
  createProject,
  createWidget,
  type DataRange,
  detectTracks,
  distributeWidgets,
  duplicateGroup,
  type EncoderSettings,
  type ExportSettings,
  embeddedSourceId,
  evaluateWorkflow,
  findGroup,
  type GeoPoint,
  type Guides,
  gpsBounds,
  groupBounds,
  groupMembers,
  groupWidgets,
  guideLines,
  mergeTrackCatalogs,
  moveGroup,
  moveLayer,
  type OutputSettings,
  type Palette,
  type Project,
  type ProjectMedia,
  removeGroup,
  removeSource,
  removeVideo,
  type SourceKind,
  type SourceRef,
  type StepId,
  type StepStatus,
  type SyncResult,
  seriesGpsPath,
  setItemOffset,
  setItemSynced,
  setOutput,
  setPalette,
  setSourceEnabled,
  setVideoEnabled,
  setWidgetGroup,
  type TelemetrySeries,
  type Template,
  type Timeline,
  TRACK_CATALOG,
  type Track,
  type TrackMatch,
  ungroupWidgets,
  updateGroup,
  type ValueScript,
  ValueScriptSchema,
  type VideoInfo,
  type Widget,
  type WidgetGroup,
  widgetFrame,
  widgetInputs,
  withCatalogLines,
} from '@custom-overlay/core';
import type { ExportProgress, ExportResult } from '@custom-overlay/core/node';
import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import type { OpenedProject, ValuesSnapshot } from '../shared/api';
import { api } from './api';
import { t } from './i18n';

/** The export of this session: running with its progress, or how the last one ended. */
export type ExportState =
  | { status: 'idle' }
  | { status: 'running'; progress: ExportProgress | null }
  | { status: 'done'; result: ExportResult }
  | { status: 'failed'; message: string }
  | { status: 'cancelled' };

interface SeekRequest {
  time: number;
  id: number;
}

interface AppState {
  projectPath: string | null;
  project: Project;
  dirty: boolean;
  /** Loaded video info by video id. */
  videos: Record<string, VideoInfo>;
  /** media:// URL of each loaded video. */
  mediaUrls: Record<string, string>;
  /** Loaded telemetry by source id (embedded telemetry included). */
  series: Record<string, TelemetrySeries>;
  /** Load errors by video or source id. */
  errors: Record<string, string>;
  loading: Record<string, boolean>;
  /** Candidates of the last automatic sync, by item id. */
  syncResults: Record<string, SyncResult[]>;
  /** Every value evaluated at the preview frame rate (refreshed while the template step is open). */
  values: ValuesSnapshot | null;
  valuesError: string | null;
  /** Values are being evaluated (after a change of media, sync, track, scripts...). */
  valuesBusy: boolean;
  /** The widget whose settings are shown (one of the selected ones). */
  selectedWidgetId: string | null;
  /** Every selected widget, the shown one included (a group's members while it is selected). */
  selectedWidgetIds: string[];
  /** The selected group, its settings shown instead of a widget's. */
  selectedGroupId: string | null;
  /** What dragged widgets snap to. */
  snapTo: SnapTarget;
  /** What the align buttons align to. */
  alignTo: AlignTarget;
  /** Values typed in the editor to test widgets (not saved). */
  testValues: Record<string, number>;
  /** Preview widgets with the synthetic sample session instead of the project data. */
  sampleData: boolean;
  /** Snap widgets to the guides while dragging (Alt inverts it). */
  snap: boolean;
  /** Show the template's snap lines over the editor. */
  showGuides: boolean;
  step: StepId;
  /** Playhead, in timeline seconds. */
  currentTime: number;
  seekRequest: SeekRequest | null;
  notice: { kind: 'error' | 'info'; message: string } | null;
  exportState: ExportState;
  /** Why the new project dialog is open: the app just started, or the user asked for a new project. */
  naming: 'startup' | 'new' | null;
  /** Lines of a known track were loaded on their own for this project (only once). */
  trackDetected: boolean;
}

/** Known tracks: bundled with the app, updated from GitHub. Kept across projects. */
interface TrackCatalogState {
  trackCatalog: CatalogTrack[];
  /** Where the list comes from: this release only, fresh from GitHub, or the last download. */
  trackCatalogSource: 'bundled' | 'github' | 'cache';
}

interface AppActions {
  /** Open the new project dialog, which asks for the name. */
  requestNewProject(reason?: 'startup' | 'new'): void;
  cancelNewProject(): void;
  newProject(name: string): void;
  /** Open `opened`, or ask the user for a project file. */
  openProject(opened?: OpenedProject): Promise<void>;
  saveProject(saveAs?: boolean): Promise<void>;
  /**
   * Add videos (asks the user when no paths are given). Offers to add the other chapters of GoPro
   * recordings; chapters are then chained by the automatic sync.
   */
  addVideos(paths?: string[]): Promise<void>;
  removeVideo(id: string): void;
  setVideoEnabled(id: string, enabled: boolean): void;
  addSources(files?: { path: string; kind: SourceKind }[]): Promise<void>;
  removeSource(id: string): void;
  setSourceEnabled(id: string, enabled: boolean): void;
  setOffset(id: string, offsetSeconds: number, synced?: boolean): void;
  setSynced(id: string, synced: boolean): void;
  /** Run every sync strategy for a video or source and apply the best one. */
  autoSync(id: string): SyncResult[];
  setTemplate(template: Template, templatePath?: string | null): void;
  setOutput(patch: Partial<OutputSettings>): void;
  setPalette(patch: Partial<Palette>): void;
  setExport(patch: Partial<ExportSettings>): void;
  /** Apply a preset, or edit values (which switches to 'custom'). */
  setEncoder(patch: Partial<EncoderSettings>): void;
  setName(name: string): void;
  /** Render the export with the current project; progress lands in `exportState`. */
  startExport(): Promise<void>;
  cancelExport(): void;
  dismissExport(): void;
  setTrack(patch: Partial<Track>): void;
  setDataRange(range: DataRange): void;
  importTrack(): Promise<void>;
  exportTrack(): Promise<void>;
  /** Replace the track lines with those of a track of the list. */
  loadCatalogTrack(entry: CatalogTrack): void;
  /** Add the latest track list from GitHub to the bundled one, then look for the session's track. */
  loadTrackCatalog(): Promise<void>;
  refreshValues(): Promise<void>;
  /** Add or replace a project value script; returns an error message when invalid. */
  saveValueScript(previousId: string | null, script: ValueScript): string | null;
  deleteValueScript(id: string): void;
  importValues(): Promise<void>;
  exportValues(): Promise<void>;
  addWidget(type: string): void;
  updateWidget(id: string, patch: Partial<Widget>): void;
  setWidgetProps(id: string, patch: Record<string, unknown>): void;
  removeWidget(id: string): void;
  duplicateWidget(id: string): void;
  /** Move a widget one step to the front (1) or the back (-1), inside its group. */
  moveWidget(id: string, direction: 1 | -1): void;
  /** Select a widget alone (`replace`), or add it to the selection / take it out (`toggle`). */
  selectWidget(id: string | null, mode?: 'replace' | 'toggle'): void;
  /** Select a group: its settings, and all its members for dragging. */
  selectGroup(id: string | null): void;
  /** Move widgets (and a group's origin) to new positions, at once. */
  placeWidgets(positions: readonly { id: string; x: number; y: number }[], origin?: GroupOrigin): void;
  /** Group the selected widgets, then select the group. */
  groupSelection(): void;
  ungroup(groupId: string): void;
  /** Put a widget in a group, or take it out with null. */
  setWidgetGroup(widgetId: string, groupId: string | null): void;
  updateGroup(groupId: string, patch: Partial<Pick<WidgetGroup, 'name' | 'visible'>>): void;
  /** Move a group (origin and relative members) by an offset. */
  moveGroupBy(groupId: string, dx: number, dy: number): void;
  /** Move a group one layer to the front (1) or the back (-1). */
  moveGroupLayer(groupId: string, direction: 1 | -1): void;
  duplicateGroup(groupId: string): void;
  /** Delete a group with its members. */
  removeGroup(groupId: string): void;
  /** Delete the selected widgets. */
  removeSelection(): void;
  /** Align the selected widgets (or the selected group's members) to `alignTo`. */
  alignSelection(edge: AlignEdge): void;
  /** Spread the selected widgets (three or more) with equal gaps. */
  distributeSelection(axis: 'horizontal' | 'vertical'): void;
  setSnapTo(target: SnapTarget): void;
  setAlignTo(target: AlignTarget): void;
  setTestValue(id: string, value: number | null): void;
  setSampleData(enabled: boolean): void;
  setSnap(enabled: boolean): void;
  setShowGuides(enabled: boolean): void;
  setGuides(patch: Partial<Guides>): void;
  importWidgets(): Promise<void>;
  exportWidget(id: string): Promise<void>;
  goTo(step: StepId): void;
  setTime(time: number): void;
  seek(time: number): void;
  notify(kind: 'error' | 'info', message: string): void;
  dismissNotice(): void;
}

export type Store = AppState & TrackCatalogState & AppActions;

/** Strip Electron's "Error invoking remote method 'x': Error:" prefix. */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');
}

const initialState = (): AppState => ({
  projectPath: null,
  project: createProject(),
  dirty: false,
  videos: {},
  mediaUrls: {},
  series: {},
  errors: {},
  loading: {},
  syncResults: {},
  values: null,
  valuesError: null,
  valuesBusy: false,
  selectedWidgetId: null,
  selectedWidgetIds: [],
  selectedGroupId: null,
  snapTo: readChoice('snapTo', SNAP_TARGETS, 'both'),
  alignTo: readChoice('alignTo', ALIGN_TARGETS, 'group'),
  testValues: {},
  sampleData: false,
  snap: readPreference('snap', true),
  showGuides: readPreference('guides', true),
  step: 'videos',
  currentTime: 0,
  seekRequest: null,
  notice: null,
  naming: null,
  exportState: { status: 'idle' },
  trackDetected: false,
});

function without<T>(record: Record<string, T>, ...keys: string[]): Record<string, T> {
  const copy = { ...record };
  for (const key of keys) delete copy[key];
  return copy;
}

/** Editor preferences of this computer (not saved in projects). */
function readPreference(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(`custom-overlay.editor.${key}`);
    return value === null ? fallback : value === '1';
  } catch {
    return fallback;
  }
}

function writePreference(key: string, value: boolean | string): void {
  try {
    localStorage.setItem(
      `custom-overlay.editor.${key}`,
      typeof value === 'string' ? value : value ? '1' : '0',
    );
  } catch {
    // Storage unavailable: the choice lasts for this session.
  }
}

function readChoice<T extends string>(key: string, choices: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(`custom-overlay.editor.${key}`);
    return choices.find((c) => c === value) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Snap a dragged widget to the guide lines, to the widgets of its group, or to both. */
export const SNAP_TARGETS = ['guides', 'group', 'both'] as const;
export type SnapTarget = (typeof SNAP_TARGETS)[number];
/**
 * Align to the group: the box around the selected group, the selection, the widget's group, or
 * the frame for a widget on its own. Or to the nearest guide lines.
 */
export const ALIGN_TARGETS = ['group', 'guides'] as const;
export type AlignTarget = (typeof ALIGN_TARGETS)[number];

export interface GroupOrigin {
  id: string;
  x: number;
  y: number;
}

/** Ids of the widgets the selection acts on: the selected group's members, or the selected ones. */
export function selectionIds(
  state: Pick<AppState, 'project' | 'selectedWidgetIds' | 'selectedGroupId'>,
): string[] {
  const { template } = state.project;
  if (state.selectedGroupId) return groupMembers(template, state.selectedGroupId).map((w) => w.id);
  const known = new Set(template.widgets.map((w) => w.id));
  return state.selectedWidgetIds.filter((id) => known.has(id));
}

/** What the selection aligns to (see `AlignTarget`). */
function alignReference(state: AppState): AlignReference {
  const { template } = state.project;
  if (state.alignTo === 'guides') return { kind: 'lines', ...guideLines(template.guides) };
  const frame = { x: 0, y: 0, width: 1, height: 1 };
  if (state.selectedGroupId)
    return { kind: 'box', box: groupBounds(template, state.selectedGroupId) ?? frame };
  const ids = selectionIds(state);
  const selected = template.widgets.filter((w) => ids.includes(w.id));
  if (selected.length > 1) return { kind: 'box', box: boundsOf(selected) ?? frame };
  const group = selected[0]?.groupId ?? null;
  return { kind: 'box', box: (group && groupBounds(template, group)) || frame };
}

/** GPS paths of the enabled sources (embedded telemetry included) that are loaded. */
function enabledGpsPaths(sources: SourceRef[], series: Record<string, TelemetrySeries>) {
  return sources.flatMap((source) => {
    const loaded = source.enabled ? series[source.id] : undefined;
    const path = loaded && seriesGpsPath(loaded);
    return path ? [path] : [];
  });
}

let seekId = 0;

/** Value evaluations in flight: a new one can start before the previous one ends. */
let valuesRequests = 0;

/** Values shown while editing are evaluated at most at this rate. */
const PREVIEW_FRAME_RATE = 30;

export const useStore = create<Store>()((set, get) => {
  const updateProject = (fn: (project: Project) => Project) =>
    set((s) => ({ project: fn(s.project), dirty: true }));

  const updateWidgets = (fn: (widgets: Widget[]) => Widget[]) =>
    updateProject((p) => ({ ...p, template: { ...p.template, widgets: fn(p.template.widgets) } }));

  const updateTemplate = (fn: (template: Template) => Template) =>
    updateProject((p) => ({ ...p, template: fn(p.template) }));

  const setLoading = (id: string, value: boolean) => set((s) => ({ loading: { ...s.loading, [id]: value } }));

  const media = (): ProjectMedia => ({ videos: get().videos, series: get().series });

  async function loadSourceData(id: string, path: string, kind: SourceKind): Promise<void> {
    setLoading(id, true);
    try {
      const series = await api().loadSource(path, kind);
      set((s) => ({ series: { ...s.series, [id]: series }, errors: without(s.errors, id) }));
    } catch (error) {
      set((s) => ({ errors: { ...s.errors, [id]: errorMessage(error) } }));
    } finally {
      setLoading(id, false);
    }
  }

  async function loadProjectVideo(id: string, path: string): Promise<void> {
    setLoading(id, true);
    try {
      const loaded = await api().loadVideo(path);
      set((s) => ({
        videos: { ...s.videos, [id]: loaded.info },
        mediaUrls: { ...s.mediaUrls, [id]: loaded.mediaUrl },
        series: loaded.telemetry ? { ...s.series, [embeddedSourceId(id)]: loaded.telemetry } : s.series,
        errors: without(s.errors, id),
      }));
    } catch (error) {
      set((s) => ({ errors: { ...s.errors, [id]: errorMessage(error) } }));
    } finally {
      setLoading(id, false);
    }
  }

  /** Sync every item that is not synced yet; runs by default whenever media loads. */
  function autoSyncPending(): void {
    const report = autoSyncProject(get().project, media());
    if (report.results.length === 0) return;
    const syncResults = { ...get().syncResults };
    for (const outcome of report.results) syncResults[outcome.itemId] = outcome.candidates;
    set({ project: report.project, dirty: true, syncResults });
    const review = report.results.filter((r) => (r.result?.confidence ?? 0) < AUTO_SYNC_MIN_CONFIDENCE);
    if (review.length > 0) {
      get().notify('info', t('app.notices.checkSync', { items: review.map((r) => r.label).join(', ') }));
    }
  }

  /**
   * Load the lines of the known track the session drove on, when the project has none. Runs
   * whenever media loads, until lines were loaded once; never with logger timing.
   */
  function detectTrackPending(): void {
    const { project, series, trackDetected } = get();
    const { track } = project;
    if (trackDetected || track.startFinish || track.sectors.length > 0 || track.timing === 'imported') return;
    const match = bestTrackMatch(detectTracks(enabledGpsPaths(project.sources, series), get().trackCatalog));
    if (!match) return;
    set({ trackDetected: true });
    updateProject((p) => ({ ...p, track: withCatalogLines(p.track, match.entry) }));
    get().notify('info', t('app.notices.trackDetected', { name: match.entry.track.name }));
  }

  /** After media loads: known track lines first, so a sync warning is the notice left shown. */
  function afterMediaLoad(): void {
    detectTrackPending();
    autoSyncPending();
  }

  return {
    ...initialState(),
    // Not in initialState: a new or opened project keeps the downloaded list.
    trackCatalog: [...TRACK_CATALOG],
    trackCatalogSource: 'bundled',

    requestNewProject(reason = 'new') {
      set({ naming: reason });
    },

    cancelNewProject() {
      set({ naming: null });
    },

    newProject(name) {
      set({ ...initialState(), exportState: get().exportState, project: createProject({ name }) });
    },

    async openProject(opened) {
      try {
        const selected = opened ?? (await api().openProject());
        if (!selected) return;
        const { project } = selected;
        set({
          ...initialState(),
          exportState: get().exportState,
          projectPath: selected.path,
          project,
          step: 'summary',
        });
        await Promise.all([
          ...project.videos.map((v) => loadProjectVideo(v.id, v.path)),
          ...project.sources
            .filter((s) => s.videoId === null)
            .map((s) => loadSourceData(s.id, s.path, s.kind)),
        ]);
        afterMediaLoad();
      } catch (error) {
        get().notify('error', t('app.notices.openProjectFailed', { error: errorMessage(error) }));
      }
    },

    async saveProject(saveAs = false) {
      const { project, projectPath } = get();
      try {
        const saved = await api().saveProject(saveAs ? null : projectPath, project);
        if (saved) set({ projectPath: saved, dirty: false });
      } catch (error) {
        get().notify('error', t('app.notices.saveProjectFailed', { error: errorMessage(error) }));
      }
    },

    async addVideos(paths) {
      const picked = paths ?? (await api().selectVideos());
      if (picked.length === 0) return;
      const existing = get().project.videos.map((v) => v.path);
      const selected = await api()
        .withChapters(picked, existing)
        .catch(() => picked);
      for (const path of selected) {
        set((s) => ({ loading: { ...s.loading, [path]: true } }));
        try {
          const loaded = await api().loadVideo(path);
          const { project, video } = addVideo(get().project, {
            path,
            info: loaded.info,
            hasTelemetry: loaded.telemetry !== null,
            telemetryKind: loaded.telemetry?.kind,
          });
          set((s) => ({
            project,
            dirty: true,
            videos: { ...s.videos, [video.id]: loaded.info },
            mediaUrls: { ...s.mediaUrls, [video.id]: loaded.mediaUrl },
            series: loaded.telemetry
              ? { ...s.series, [embeddedSourceId(video.id)]: loaded.telemetry }
              : s.series,
          }));
        } catch (error) {
          get().notify('error', t('app.notices.loadFailed', { path, error: errorMessage(error) }));
        } finally {
          set((s) => ({ loading: without(s.loading, path) }));
        }
      }
      if (selected.length > 0) afterMediaLoad();
    },

    removeVideo(id) {
      set((s) => ({
        videos: without(s.videos, id),
        mediaUrls: without(s.mediaUrls, id),
        series: without(s.series, embeddedSourceId(id)),
        errors: without(s.errors, id),
        syncResults: without(s.syncResults, id),
      }));
      updateProject((p) => removeVideo(p, id));
    },

    setVideoEnabled(id, enabled) {
      updateProject((p) => setVideoEnabled(p, id, enabled));
    },

    async addSources(files) {
      const selected = files ?? (await api().selectSources());
      const added: { id: string; path: string; kind: SourceKind }[] = [];
      for (const file of selected) {
        const result = addSource(get().project, file);
        set({ project: result.project, dirty: true });
        added.push({ id: result.source.id, ...file });
      }
      await Promise.all(added.map((s) => loadSourceData(s.id, s.path, s.kind)));
      if (added.length > 0) afterMediaLoad();
    },

    removeSource(id) {
      set((s) => ({
        series: without(s.series, id),
        errors: without(s.errors, id),
        syncResults: without(s.syncResults, id),
      }));
      updateProject((p) => removeSource(p, id));
    },

    setSourceEnabled(id, enabled) {
      updateProject((p) => setSourceEnabled(p, id, enabled));
    },

    setOffset(id, offsetSeconds, synced = false) {
      updateProject((p) => setItemOffset(p, id, Math.round(offsetSeconds * 1000) / 1000, synced));
    },

    setSynced(id, synced) {
      updateProject((p) => setItemSynced(p, id, synced));
    },

    autoSync(id) {
      const candidates = autoSyncItem(get().project, media(), id);
      const [best] = candidates;
      set((s) => ({ syncResults: { ...s.syncResults, [id]: candidates } }));
      if (best) updateProject((p) => applySyncResult(p, id, best));
      return candidates;
    },

    setTemplate(template, templatePath) {
      updateProject((p) => ({
        ...p,
        template,
        templatePath: templatePath === undefined ? p.templatePath : templatePath,
      }));
    },

    setOutput(patch) {
      updateProject((p) => setOutput(p, patch));
    },

    setPalette(patch) {
      updateProject((p) => setPalette(p, patch));
    },

    setExport(patch) {
      updateProject((p) => ({ ...p, export: { ...p.export, ...patch } }));
    },

    setEncoder(patch) {
      updateProject((p) => {
        // The acceleration choice is not part of a preset.
        const onlyAcceleration = Object.keys(patch).every((key) => key === 'acceleration');
        if (patch.preset && patch.preset !== 'custom')
          return applyPreset(p, patch.preset, patch.acceleration);
        const encoder = onlyAcceleration
          ? { ...p.export.encoder, ...patch }
          : { ...p.export.encoder, ...patch, preset: 'custom' };
        return { ...p, export: { ...p.export, encoder } };
      });
    },

    async startExport() {
      if (get().exportState.status === 'running') return;
      set({ exportState: { status: 'running', progress: null } });
      const stop = api().onExportProgress((progress) => {
        if (get().exportState.status === 'running') set({ exportState: { status: 'running', progress } });
      });
      try {
        const result = await api().startExport(get().project);
        set({ exportState: { status: 'done', result } });
      } catch (error) {
        const message = errorMessage(error);
        set({
          exportState: /cancelled/i.test(message) ? { status: 'cancelled' } : { status: 'failed', message },
        });
      } finally {
        stop();
      }
    },

    cancelExport() {
      void api().cancelExport();
    },

    dismissExport() {
      if (get().exportState.status !== 'running') set({ exportState: { status: 'idle' } });
    },

    setName(name) {
      updateProject((p) => ({ ...p, name }));
    },

    setDataRange(dataRange) {
      updateProject((p) => ({ ...p, dataRange }));
    },

    setTrack(patch) {
      updateProject((p) => ({ ...p, track: { ...p.track, ...patch } }));
    },

    async importTrack() {
      try {
        const track = await api().openTrack();
        if (!track) return;
        updateProject((p) => ({ ...p, track }));
        get().notify(
          'info',
          track.name
            ? t('app.notices.trackImported', { name: track.name })
            : t('app.notices.trackImportedUnnamed'),
        );
      } catch (error) {
        get().notify('error', t('app.notices.importTrackFailed', { error: errorMessage(error) }));
      }
    },

    async loadTrackCatalog() {
      const remote = await api()
        .trackCatalog()
        .catch(() => null);
      if (!remote) return;
      set({
        trackCatalog: mergeTrackCatalogs(TRACK_CATALOG, remote.tracks),
        trackCatalogSource: remote.source,
      });
      detectTrackPending();
    },

    loadCatalogTrack(entry) {
      set({ trackDetected: true });
      updateProject((p) => ({ ...p, track: withCatalogLines(p.track, entry) }));
      get().notify('info', t('app.notices.trackLoaded', { name: entry.track.name }));
    },

    async exportTrack() {
      try {
        await api().saveTrack(get().project.track);
      } catch (error) {
        get().notify('error', t('app.notices.exportTrackFailed', { error: errorMessage(error) }));
      }
    },

    async refreshValues() {
      const { project } = get();
      valuesRequests++;
      set({ valuesBusy: true });
      try {
        const values = await api().evaluateValues(
          project,
          Math.min(project.output.frameRate, PREVIEW_FRAME_RATE),
        );
        // Ignore results of a project that changed meanwhile.
        if (get().project === project) set({ values, valuesError: null });
      } catch (error) {
        set({ valuesError: errorMessage(error) });
      } finally {
        valuesRequests--;
        set({ valuesBusy: valuesRequests > 0 });
      }
    },

    saveValueScript(previousId, script) {
      const parsed = ValueScriptSchema.safeParse(script);
      if (!parsed.success) {
        return parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
      }
      const { values } = get().project;
      if (script.id !== previousId && values.some((v) => v.id === script.id)) {
        return t('app.notices.duplicateValueId', { id: script.id });
      }
      updateProject((p) => {
        const index = p.values.findIndex((v) => v.id === previousId);
        const next = [...p.values];
        if (index >= 0) next[index] = parsed.data;
        else next.push(parsed.data);
        return { ...p, values: next };
      });
      return null;
    },

    deleteValueScript(id) {
      updateProject((p) => ({ ...p, values: p.values.filter((v) => v.id !== id) }));
    },

    async importValues() {
      try {
        const collection = await api().openValueCollection();
        if (!collection) return;
        const ids = new Set(collection.values.map((v) => v.id));
        updateProject((p) => ({
          ...p,
          values: [...p.values.filter((v) => !ids.has(v.id)), ...collection.values],
        }));
        get().notify(
          'info',
          t('app.notices.valuesImported', { count: collection.values.length, name: collection.name }),
        );
      } catch (error) {
        get().notify('error', t('app.notices.importValuesFailed', { error: errorMessage(error) }));
      }
    },

    async exportValues() {
      const { project } = get();
      try {
        await api().saveValueCollection({
          version: 1,
          name: `${project.name} values`,
          values: project.values,
        });
      } catch (error) {
        get().notify('error', t('app.notices.exportValuesFailed', { error: errorMessage(error) }));
      }
    },

    addWidget(type) {
      const widget = createWidget(type, {}, widgetFrame(get().project.output));
      updateWidgets((widgets) => [...widgets, widget]);
      get().selectWidget(widget.id);
    },

    updateWidget(id, patch) {
      updateWidgets((widgets) => widgets.map((w) => (w.id === id ? { ...w, ...patch } : w)));
    },

    setWidgetProps(id, patch) {
      updateWidgets((widgets) =>
        widgets.map((w) => (w.id === id ? { ...w, props: { ...w.props, ...patch } } : w)),
      );
    },

    removeWidget(id) {
      updateTemplate((template) =>
        cleanGroupsOf({ ...template, widgets: template.widgets.filter((w) => w.id !== id) }),
      );
      set((s) => ({
        selectedWidgetId: s.selectedWidgetId === id ? null : s.selectedWidgetId,
        selectedWidgetIds: s.selectedWidgetIds.filter((selected) => selected !== id),
      }));
    },

    duplicateWidget(id) {
      const { widgets } = get().project.template;
      const index = widgets.findIndex((w) => w.id === id);
      const source = widgets[index];
      if (!source) return;
      const copy: Widget = {
        ...structuredClone(source),
        id: createId('w'),
        x: source.x + 0.02,
        y: source.y + 0.02,
      };
      // A copy of a group member stays in the group, just in front of it.
      updateWidgets((current) =>
        source.groupId
          ? [...current.slice(0, index + 1), copy, ...current.slice(index + 1)]
          : [...current, copy],
      );
      get().selectWidget(copy.id);
    },

    moveWidget(id, direction) {
      updateTemplate((template) => moveLayer(template, { widgetId: id }, direction));
    },

    selectWidget(id, mode = 'replace') {
      if (id === null) {
        set({ selectedWidgetId: null, selectedWidgetIds: [], selectedGroupId: null });
        return;
      }
      if (mode === 'replace') {
        set({ selectedWidgetId: id, selectedWidgetIds: [id], selectedGroupId: null });
        return;
      }
      const current = selectionIds(get());
      const ids = current.includes(id) ? current.filter((s) => s !== id) : [...current, id];
      set({
        selectedWidgetId: ids.includes(id) ? id : (ids[ids.length - 1] ?? null),
        selectedWidgetIds: ids,
        selectedGroupId: null,
      });
    },

    selectGroup(id) {
      const group = findGroup(get().project.template, id);
      set({
        selectedGroupId: group ? group.id : null,
        selectedWidgetId: null,
        selectedWidgetIds: group ? groupMembers(get().project.template, group.id).map((w) => w.id) : [],
      });
    },

    placeWidgets(positions, origin) {
      const byId = new Map(positions.map((p) => [p.id, p]));
      updateTemplate((template) => ({
        ...template,
        widgets: template.widgets.map((w) => {
          const at = byId.get(w.id);
          return at ? { ...w, x: at.x, y: at.y } : w;
        }),
        groups: origin
          ? template.groups.map((g) => (g.id === origin.id ? { ...g, x: origin.x, y: origin.y } : g))
          : template.groups,
      }));
    },

    groupSelection() {
      const ids = selectionIds(get());
      const { template, groupId } = groupWidgets(
        get().project.template,
        ids,
        t('template.groups.defaultName', { number: get().project.template.groups.length + 1 }),
      );
      if (!groupId) return;
      updateTemplate(() => template);
      get().selectGroup(groupId);
    },

    ungroup(groupId) {
      const members = groupMembers(get().project.template, groupId).map((w) => w.id);
      updateTemplate((template) => ungroupWidgets(template, groupId));
      set({
        selectedGroupId: null,
        selectedWidgetIds: members,
        selectedWidgetId: members[members.length - 1] ?? null,
      });
    },

    setWidgetGroup(widgetId, groupId) {
      updateTemplate((template) => setWidgetGroup(template, widgetId, groupId));
    },

    updateGroup(groupId, patch) {
      updateTemplate((template) => updateGroup(template, groupId, patch));
    },

    moveGroupBy(groupId, dx, dy) {
      updateTemplate((template) => moveGroup(template, groupId, dx, dy));
    },

    moveGroupLayer(groupId, direction) {
      updateTemplate((template) => moveLayer(template, { groupId }, direction));
    },

    duplicateGroup(groupId) {
      const copy = duplicateGroup(get().project.template, groupId);
      if (!copy.groupId) return;
      updateTemplate(() => copy.template);
      get().selectGroup(copy.groupId);
    },

    removeGroup(groupId) {
      updateTemplate((template) => removeGroup(template, groupId));
      get().selectWidget(null);
    },

    removeSelection() {
      const ids = new Set(selectionIds(get()));
      updateTemplate((template) =>
        cleanGroupsOf({ ...template, widgets: template.widgets.filter((w) => !ids.has(w.id)) }),
      );
      get().selectWidget(null);
    },

    alignSelection(edge) {
      const state = get();
      const ids = selectionIds(state);
      if (ids.length === 0) return;
      const reference = alignReference(state);
      updateTemplate((template) => alignWidgets(template, ids, edge, reference));
    },

    distributeSelection(axis) {
      const ids = selectionIds(get());
      updateTemplate((template) => distributeWidgets(template, ids, axis));
    },

    setSnapTo(target) {
      writePreference('snapTo', target);
      set({ snapTo: target });
    },

    setAlignTo(target) {
      writePreference('alignTo', target);
      set({ alignTo: target });
    },

    setTestValue(id, value) {
      set((s) => ({
        testValues: value === null ? without(s.testValues, id) : { ...s.testValues, [id]: value },
      }));
    },

    setSnap(enabled) {
      writePreference('snap', enabled);
      set({ snap: enabled });
    },

    setShowGuides(enabled) {
      writePreference('guides', enabled);
      set({ showGuides: enabled });
    },

    setGuides(patch) {
      updateProject((p) => ({
        ...p,
        template: { ...p.template, guides: { ...p.template.guides, ...patch } },
      }));
    },

    setSampleData(enabled) {
      set({ sampleData: enabled });
    },

    async importWidgets() {
      try {
        const widgets = await api().openWidgets();
        if (widgets.length === 0) return;
        // New ids so imported widgets never collide with existing ones; their groups stay behind.
        const fresh = widgets.map((w) => ({ ...w, id: createId('w'), groupId: null }));
        updateWidgets((current) => [...current, ...fresh]);
        const last = fresh[fresh.length - 1];
        if (last) get().selectWidget(last.id);
      } catch (error) {
        get().notify('error', t('app.notices.importWidgetsFailed', { error: errorMessage(error) }));
      }
    },

    async exportWidget(id) {
      const widget = get().project.template.widgets.find((w) => w.id === id);
      if (!widget) return;
      try {
        await api().saveWidget(widget);
      } catch (error) {
        get().notify('error', t('app.notices.exportWidgetFailed', { error: errorMessage(error) }));
      }
    },

    goTo(step) {
      set({ step });
    },

    setTime(time) {
      set({ currentTime: time });
    },

    seek(time) {
      seekId++;
      set({ currentTime: time, seekRequest: { time, id: seekId } });
    },

    notify(kind, message) {
      set({ notice: { kind, message } });
    },

    dismissNotice() {
      set({ notice: null });
    },
  };
});

/** A heavy task the app waits for; editing is blocked meanwhile (see BusyMask). */
export type BusyTask =
  | { kind: 'export'; progress: ExportProgress | null }
  | { kind: 'media'; files: string[] }
  | { kind: 'values' };

/** Whether a heavy task is running: keyboard shortcuts are ignored meanwhile. */
export function isBusy(state: Store): boolean {
  return (
    state.exportState.status === 'running' || Object.values(state.loading).some(Boolean) || state.valuesBusy
  );
}

/** The heavy task running now, the most important first, null when the app is idle. */
export function useBusyTask(): BusyTask | null {
  const exportState = useStore((s) => s.exportState);
  const loading = useStore((s) => s.loading);
  const valuesBusy = useStore((s) => s.valuesBusy);
  const videos = useStore((s) => s.project.videos);
  const sources = useStore((s) => s.project.sources);
  return useMemo(() => {
    if (exportState.status === 'running') return { kind: 'export', progress: exportState.progress };
    // Loading keys are video or source ids, or the path of a video being added.
    const label = (key: string) =>
      videos.find((v) => v.id === key)?.label ??
      sources.find((s) => s.id === key)?.label ??
      key.split(/[\\/]/).pop() ??
      key;
    const files = Object.keys(loading)
      .filter((key) => loading[key])
      .map(label);
    if (files.length > 0) return { kind: 'media', files };
    return valuesBusy ? { kind: 'values' } : null;
  }, [exportState, loading, valuesBusy, videos, sources]);
}

/** Loaded media in the shape the core expects. */
export function useMedia(): ProjectMedia {
  const videos = useStore((s) => s.videos);
  const series = useStore((s) => s.series);
  return useMemo(() => ({ videos, series }), [videos, series]);
}

function useGpsPaths() {
  const sources = useStore((s) => s.project.sources);
  const series = useStore((s) => s.series);
  return useMemo(() => enabledGpsPaths(sources, series), [sources, series]);
}

/** Known tracks the enabled sources drove on, best first. */
export function useTrackMatches(): TrackMatch[] {
  const paths = useGpsPaths();
  const catalog = useStore((s) => s.trackCatalog);
  return useMemo(() => detectTracks(paths, catalog), [paths, catalog]);
}

/** Middle of the session's GPS positions, null without GPS: nearby tracks are measured from it. */
export function useSessionCentre(): GeoPoint | null {
  const paths = useGpsPaths();
  return useMemo(() => {
    const box = gpsBounds(paths);
    return box ? boundsCentre(box) : null;
  }, [paths]);
}

/** Workflow status derived from the store. */
export function useWorkflow(): StepStatus[] {
  const project = useStore((s) => s.project);
  const errors = useStore((s) => s.errors);
  return useMemo(
    () =>
      evaluateWorkflow({
        project,
        failedIds: Object.keys(errors),
        videoExport: api().capabilities.videoExport,
        asksOutput: !api().capabilities.nativeExport,
      }),
    [project, errors],
  );
}

export function useTimeline(): Timeline {
  const project = useStore((s) => s.project);
  const media = useMedia();
  return useMemo(() => computeTimeline(project, media), [project, media]);
}

/**
 * Re-evaluate values shortly after anything that changes them (media, sync, scripts, frame
 * rate, track lines) — not on widget edits.
 */
export function useValuesRefresh(): void {
  const project = useStore((s) => s.project);
  const series = useStore((s) => s.series);
  const videos = useStore((s) => s.videos);
  const refresh = useStore((s) => s.refreshValues);
  const key = useMemo(
    () =>
      JSON.stringify({
        videos: project.videos,
        sources: project.sources,
        values: project.values,
        templateValues: project.template.values,
        frameRate: project.output.frameRate,
        track: project.track,
        dataRange: project.dataRange,
        // Widgets with their own data range: what they read is computed for that range.
        widgetRanges: project.template.widgets
          .filter((w) => w.dataRange)
          .map((w) => [w.dataRange, widgetInputs(w)]),
      }),
    [
      project.videos,
      project.sources,
      project.values,
      project.template.values,
      project.output.frameRate,
      project.track,
      project.dataRange,
      project.template.widgets,
    ],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh when values inputs change
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 300);
    return () => clearTimeout(timer);
  }, [key, series, videos, refresh]);
}
