import {
  createTemplate,
  createWidget,
  embeddedSourceId,
  type Project,
  TRACK_CATALOG,
  type ValueScript,
} from '@custom-overlay/core';
import type { ExportProgress, ExportResult } from '@custom-overlay/core/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMessage, isBusy, useStore } from '../../src/app/store';
import {
  api,
  gpsSeries,
  loadedVideo,
  loadSession,
  project,
  resetStores,
  SESSION_EPOCH_MS,
  sessionProject,
  speedSeries,
  TEST_TRACK,
  valuesSnapshot,
} from './helpers/project';

const store = () => useStore.getState();

beforeEach(() => {
  localStorage.clear();
  resetStores();
});

const script = (overrides: Partial<ValueScript> = {}): ValueScript => ({
  id: 'speed.double',
  name: 'Double speed',
  description: '',
  unit: 'm/s',
  initial: 0,
  code: 'return value("speed") * 2;',
  ...overrides,
});

const exportResult: ExportResult = {
  outputPath: '/out/run.mp4',
  frames: 3600,
  seconds: 12,
  encoder: 'libx264',
  warnings: [],
} as unknown as ExportResult;

describe('errorMessage', () => {
  it("strips Electron's remote method prefix", () => {
    expect(
      errorMessage(new Error("Error invoking remote method 'media:load-video': Error: Not a video")),
    ).toBe('Not a video');
    expect(errorMessage(new Error("Error invoking remote method 'x': TypeError: bad"))).toBe('bad');
    expect(errorMessage(new Error('plain'))).toBe('plain');
    expect(errorMessage('a string')).toBe('a string');
  });
});

describe('new and open projects', () => {
  it('asks for the name of a new project', () => {
    store().requestNewProject();
    expect(store().naming).toBe('new');
    store().requestNewProject('startup');
    expect(store().naming).toBe('startup');
    store().cancelNewProject();
    expect(store().naming).toBeNull();
  });

  it('starts over with a named project, keeping the export state', () => {
    useStore.setState({
      dirty: true,
      projectPath: '/p.json',
      exportState: { status: 'cancelled' },
      step: 'sync',
    });
    store().newProject('Monza');
    expect(store().project.name).toBe('Monza');
    expect(store()).toMatchObject({
      dirty: false,
      projectPath: null,
      step: 'videos',
      exportState: { status: 'cancelled' },
    });
  });

  it('opens a project, loads its media and syncs what is not synced', async () => {
    const session = sessionProject();
    api().loadVideo.mockResolvedValue(
      loadedVideo('/videos/GX010001.MP4', session.series[embeddedSourceId(session.videoId)] ?? null),
    );
    api().loadSource.mockResolvedValue(session.series[session.sourceId] as never);
    api().openProject.mockResolvedValue({ path: '/projects/run.json', project: session.project });

    await store().openProject();

    expect(api().loadVideo).toHaveBeenCalledWith('/videos/GX010001.MP4');
    // Only the logger: embedded telemetry comes with its video.
    expect(api().loadSource).toHaveBeenCalledTimes(1);
    expect(api().loadSource).toHaveBeenCalledWith('/logs/session.csv', 'racechrono');
    const state = store();
    expect(state.projectPath).toBe('/projects/run.json');
    expect(state.step).toBe('summary');
    expect(Object.keys(state.series).sort()).toEqual(
      [embeddedSourceId(session.videoId), session.sourceId].sort(),
    );
    expect(state.mediaUrls[session.videoId]).toMatch(/^media:\/\//);
    expect(state.loading).toEqual({ [session.videoId]: false, [session.sourceId]: false });
    const source = state.project.sources.find((s) => s.id === session.sourceId);
    expect(source).toMatchObject({ offsetSeconds: -20, synced: true });
    expect(state.syncResults[session.sourceId]?.length).toBeGreaterThan(0);
    // A confident sync needs no review.
    expect(state.notice).toBeNull();
  });

  it('asks to check a sync it is not sure about', async () => {
    const session = sessionProject();
    api().loadVideo.mockResolvedValue(
      loadedVideo('/videos/GX010001.MP4', speedSeries({ kind: 'gopro', offset: 20 })),
    );
    api().loadSource.mockResolvedValue(speedSeries({ duration: 120 }));
    await store().openProject({ path: '/p.json', project: session.project });
    expect(api().openProject).not.toHaveBeenCalled();
    expect(store().notice).toEqual({ kind: 'info', message: 'Check the sync of: session.csv' });
  });

  it('records media that fails to load', async () => {
    const session = sessionProject();
    api().loadVideo.mockRejectedValue(new Error("Error invoking remote method 'm': Error: missing file"));
    api().loadSource.mockRejectedValue(new Error('unreadable'));
    await store().openProject({ path: '/p.json', project: session.project });
    expect(store().errors).toEqual({ [session.videoId]: 'missing file', [session.sourceId]: 'unreadable' });
    expect(store().videos).toEqual({});
  });

  it('keeps the current project when the dialog is cancelled', async () => {
    store().setName('Kept');
    await store().openProject();
    expect(store().project.name).toBe('Kept');
    expect(store().dirty).toBe(true);
  });

  it('reports a project that cannot be opened', async () => {
    api().openProject.mockRejectedValue(new Error('invalid project file'));
    await store().openProject();
    expect(store().notice).toEqual({
      kind: 'error',
      message: 'Could not open the project: invalid project file',
    });
  });

  it('loads a video without telemetry', async () => {
    const withVideo = { ...project(), videos: [] } as Project;
    const session = sessionProject();
    const opened: Project = { ...withVideo, videos: session.project.videos, sources: [] };
    api().loadVideo.mockResolvedValue(loadedVideo('/videos/GX010001.MP4'));
    await store().openProject({ path: '/p.json', project: opened });
    expect(store().series).toEqual({});
    expect(store().videos[session.videoId]?.path).toBe('/videos/GX010001.MP4');
  });
});

describe('saving', () => {
  it('saves to the project path and clears the changes', async () => {
    useStore.setState({ projectPath: '/p.json', dirty: true });
    api().saveProject.mockResolvedValue('/p.json');
    await store().saveProject();
    expect(api().saveProject).toHaveBeenCalledWith('/p.json', store().project);
    expect(store().dirty).toBe(false);
  });

  it('asks for a location with save as', async () => {
    useStore.setState({ projectPath: '/p.json', dirty: true });
    api().saveProject.mockResolvedValue('/other.json');
    await store().saveProject(true);
    expect(api().saveProject).toHaveBeenCalledWith(null, expect.anything());
    expect(store().projectPath).toBe('/other.json');
  });

  it('stays dirty when cancelled and reports failures', async () => {
    useStore.setState({ dirty: true });
    await store().saveProject();
    expect(store().dirty).toBe(true);
    api().saveProject.mockRejectedValue(new Error('disk full'));
    await store().saveProject();
    expect(store().notice).toEqual({ kind: 'error', message: 'Could not save the project: disk full' });
  });
});

describe('videos', () => {
  it('adds the selected videos with their chapters', async () => {
    api().selectVideos.mockResolvedValue(['/v/GX010001.MP4']);
    api().withChapters.mockResolvedValue(['/v/GX010001.MP4', '/v/GX020001.MP4']);
    api().loadVideo.mockImplementation(async (path) =>
      loadedVideo(path, speedSeries({ kind: 'gopro' }), { durationSeconds: 30 }),
    );
    await store().addVideos();
    expect(api().withChapters).toHaveBeenCalledWith(['/v/GX010001.MP4'], []);
    const { project: p, videos, series, loading, dirty } = store();
    expect(p.videos.map((v) => v.path)).toEqual(['/v/GX010001.MP4', '/v/GX020001.MP4']);
    expect(Object.keys(videos)).toHaveLength(2);
    expect(Object.keys(series)).toEqual(p.videos.map((v) => embeddedSourceId(v.id)));
    expect(loading).toEqual({});
    expect(dirty).toBe(true);
  });

  it('does nothing when no video is picked', async () => {
    await store().addVideos();
    expect(api().withChapters).not.toHaveBeenCalled();
    expect(store().dirty).toBe(false);
  });

  it('adds nothing when every picked video is already in the project', async () => {
    api().withChapters.mockResolvedValue([]);
    await store().addVideos(['/v/GX010001.MP4']);
    expect(api().loadVideo).not.toHaveBeenCalled();
    expect(store().project.videos).toEqual([]);
  });

  it('adds the picked videos when chapters cannot be read, reporting failures', async () => {
    api().withChapters.mockRejectedValue(new Error('no access'));
    api().loadVideo.mockImplementation(async (path) => {
      if (path.endsWith('bad.mp4')) throw new Error('not a video');
      return loadedVideo(path);
    });
    await store().addVideos(['/v/good.mp4', '/v/bad.mp4']);
    expect(store().project.videos.map((v) => v.path)).toEqual(['/v/good.mp4']);
    expect(store().series).toEqual({});
    expect(store().notice).toEqual({ kind: 'error', message: 'Could not load /v/bad.mp4: not a video' });
  });

  it('removes a video with its media, errors and sync results', () => {
    const session = loadSession();
    useStore.setState({
      errors: { [session.videoId]: 'x' },
      syncResults: { [session.videoId]: [] },
    });
    store().removeVideo(session.videoId);
    const state = store();
    expect(state.project.videos).toEqual([]);
    expect(state.videos).toEqual({});
    expect(state.mediaUrls).toEqual({});
    expect(Object.keys(state.series)).toEqual([session.sourceId]);
    expect(state.errors).toEqual({});
    expect(state.syncResults).toEqual({});
  });

  it('enables and disables a video', () => {
    const session = loadSession();
    store().setVideoEnabled(session.videoId, false);
    expect(store().project.videos[0]?.enabled).toBe(false);
    expect(store().dirty).toBe(true);
  });
});

describe('sources', () => {
  it('adds the selected sources and loads them', async () => {
    api().selectSources.mockResolvedValue([{ path: '/logs/a.csv', kind: 'racechrono' }]);
    api().loadSource.mockResolvedValue(speedSeries());
    await store().addSources();
    const [source] = store().project.sources;
    expect(source).toMatchObject({ path: '/logs/a.csv', kind: 'racechrono' });
    expect(store().series[source?.id ?? '']).toBeDefined();
  });

  it('records sources that fail to load', async () => {
    api().loadSource.mockRejectedValue(new Error('bad csv'));
    await store().addSources([{ path: '/logs/a.csv', kind: 'racechrono' }]);
    const id = store().project.sources[0]?.id ?? '';
    expect(store().errors[id]).toBe('bad csv');
    expect(store().loading[id]).toBe(false);
  });

  it('does nothing without files', async () => {
    await store().addSources([]);
    expect(store().project.sources).toEqual([]);
    expect(store().notice).toBeNull();
  });

  it('removes and toggles sources', () => {
    const session = loadSession();
    useStore.setState({ errors: { [session.sourceId]: 'x' }, syncResults: { [session.sourceId]: [] } });
    store().setSourceEnabled(session.sourceId, false);
    expect(store().project.sources.find((s) => s.id === session.sourceId)?.enabled).toBe(false);
    store().removeSource(session.sourceId);
    expect(store().project.sources.some((s) => s.id === session.sourceId)).toBe(false);
    expect(store().series[session.sourceId]).toBeUndefined();
    expect(store().errors).toEqual({});
    expect(store().syncResults).toEqual({});
  });
});

describe('sync', () => {
  it('rounds offsets to milliseconds', () => {
    const session = loadSession();
    store().setOffset(session.sourceId, -20.12345);
    expect(store().project.sources.find((s) => s.id === session.sourceId)).toMatchObject({
      offsetSeconds: -20.123,
      synced: false,
    });
    store().setOffset(session.sourceId, 1, true);
    expect(store().project.sources.find((s) => s.id === session.sourceId)?.synced).toBe(true);
    store().setSynced(session.sourceId, false);
    expect(store().project.sources.find((s) => s.id === session.sourceId)?.synced).toBe(false);
  });

  it('applies the best automatic sync of an item', () => {
    const session = loadSession();
    const candidates = store().autoSync(session.sourceId);
    expect(candidates[0]?.offsetSeconds).toBeCloseTo(-20, 1);
    expect(store().syncResults[session.sourceId]).toBe(candidates);
    expect(store().project.sources.find((s) => s.id === session.sourceId)).toMatchObject({ synced: true });
  });

  it('keeps the offset when nothing matches', () => {
    const session = loadSession();
    useStore.setState({ series: {} });
    expect(store().autoSync(session.sourceId)).toEqual([]);
    expect(store().project.sources.find((s) => s.id === session.sourceId)?.offsetSeconds).toBe(0);
  });
});

describe('project settings', () => {
  it('replaces the template, keeping its path unless given', () => {
    const template = { ...createTemplate(), name: 'Race' };
    useStore.setState({ project: { ...store().project, templatePath: '/t/old.json' } });
    store().setTemplate(template);
    expect(store().project.template.name).toBe('Race');
    expect(store().project.templatePath).toBe('/t/old.json');
    store().setTemplate(template, '/t/race.json');
    expect(store().project.templatePath).toBe('/t/race.json');
    store().setTemplate(template, null);
    expect(store().project.templatePath).toBeNull();
  });

  it('edits output, palette, export, name, data range and track', () => {
    store().setOutput({ frameRate: 30 });
    store().setPalette({ text: '#ff0000' });
    store().setExport({ mode: 'image-sequence' });
    store().setName('Interlagos');
    store().setDataRange({ start: { kind: 'time', time: 5 }, end: null });
    store().setTrack({ name: 'My track', minLapSeconds: 30 });
    const p = store().project;
    expect(p.output.frameRate).toBe(30);
    expect(p.palette.text).toBe('#ff0000');
    expect(p.export.mode).toBe('image-sequence');
    expect(p.name).toBe('Interlagos');
    expect(p.dataRange.start).toEqual({ kind: 'time', time: 5 });
    expect(p.track).toMatchObject({ name: 'My track', minLapSeconds: 30, timing: 'auto' });
  });

  it('applies encoder presets and switches to custom on manual edits', () => {
    store().setEncoder({ preset: 'archive' });
    expect(store().project.export.encoder.preset).toBe('archive');
    store().setEncoder({ acceleration: 'software' });
    expect(store().project.export.encoder).toMatchObject({ preset: 'archive', acceleration: 'software' });
    store().setEncoder({ bitrateMbps: 50 });
    expect(store().project.export.encoder).toMatchObject({ preset: 'custom', bitrateMbps: 50 });
    store().setEncoder({ preset: 'custom', bFrames: 0 });
    expect(store().project.export.encoder).toMatchObject({ preset: 'custom', bFrames: 0 });
  });
});

describe('export', () => {
  it('runs an export, following its progress', async () => {
    let report: ((p: ExportProgress) => void) | undefined;
    const stop = vi.fn();
    api().onExportProgress.mockImplementation((listener) => {
      report = listener;
      return stop;
    });
    let finish: (r: ExportResult) => void = () => undefined;
    api().startExport.mockReturnValue(new Promise((resolve) => (finish = resolve)));

    const running = store().startExport();
    expect(store().exportState).toEqual({ status: 'running', progress: null });
    expect(isBusy(store())).toBe(true);
    const progress = { frame: 10, frames: 100 } as ExportProgress;
    report?.(progress);
    expect(store().exportState).toEqual({ status: 'running', progress });

    // A second start while running is ignored.
    await store().startExport();
    expect(api().startExport).toHaveBeenCalledTimes(1);

    finish(exportResult);
    await running;
    expect(store().exportState).toEqual({ status: 'done', result: exportResult });
    expect(stop).toHaveBeenCalled();
    // Late progress after the end is ignored.
    report?.(progress);
    expect(store().exportState.status).toBe('done');
  });

  it('tells cancelled exports from failed ones', async () => {
    api().startExport.mockRejectedValueOnce(
      new Error("Error invoking remote method 'x': Error: Export cancelled"),
    );
    await store().startExport();
    expect(store().exportState).toEqual({ status: 'cancelled' });
    api().startExport.mockRejectedValueOnce(new Error('ffmpeg exited with code 1'));
    await store().startExport();
    expect(store().exportState).toEqual({ status: 'failed', message: 'ffmpeg exited with code 1' });
  });

  it('cancels and dismisses, but never dismisses a running export', () => {
    store().cancelExport();
    expect(api().cancelExport).toHaveBeenCalled();
    useStore.setState({ exportState: { status: 'running', progress: null } });
    store().dismissExport();
    expect(store().exportState.status).toBe('running');
    useStore.setState({ exportState: { status: 'failed', message: 'x' } });
    store().dismissExport();
    expect(store().exportState).toEqual({ status: 'idle' });
  });
});

describe('track', () => {
  it('imports track lines, named or not', async () => {
    api().openTrack.mockResolvedValueOnce(TEST_TRACK.track);
    await store().importTrack();
    expect(store().project.track.name).toBe('Test Ring');
    expect(store().notice?.message).toBe("Imported the lines of 'Test Ring'");
    api().openTrack.mockResolvedValueOnce({ ...TEST_TRACK.track, name: '' });
    await store().importTrack();
    expect(store().notice?.message).toBe('Imported the track lines');
  });

  it('ignores a cancelled import and reports failures', async () => {
    await store().importTrack();
    expect(store().dirty).toBe(false);
    api().openTrack.mockRejectedValue(new Error('bad file'));
    await store().importTrack();
    expect(store().notice).toEqual({ kind: 'error', message: 'Could not import the track: bad file' });
  });

  it('exports the track lines', async () => {
    await store().exportTrack();
    expect(api().saveTrack).toHaveBeenCalledWith(store().project.track);
    api().saveTrack.mockRejectedValue(new Error('denied'));
    await store().exportTrack();
    expect(store().notice?.message).toBe('Could not export the track: denied');
  });

  it('loads the lines of a listed track', () => {
    store().loadCatalogTrack(TEST_TRACK);
    expect(store().project.track.startFinish).toEqual(TEST_TRACK.track.startFinish);
    expect(store().trackDetected).toBe(true);
    expect(store().notice?.message).toBe('Loaded the lines of Test Ring');
  });

  it('detects the known track the session drove on when media loads', async () => {
    useStore.setState({ trackCatalog: [TEST_TRACK] });
    api().loadSource.mockResolvedValue(gpsSeries());
    await store().addSources([{ path: '/logs/gps.csv', kind: 'racechrono' }]);
    expect(store().trackDetected).toBe(true);
    expect(store().project.track.name).toBe('Test Ring');
    expect(store().project.track.startFinish).toEqual(TEST_TRACK.track.startFinish);
  });

  it('never replaces lines the project already has', async () => {
    useStore.setState({ trackCatalog: [TEST_TRACK] });
    store().setTrack({ name: 'Mine', sectors: [TEST_TRACK.track.startFinish as never] });
    api().loadSource.mockResolvedValue(gpsSeries());
    await store().addSources([{ path: '/logs/gps.csv', kind: 'racechrono' }]);
    expect(store().trackDetected).toBe(false);
    expect(store().project.track.name).toBe('Mine');
  });

  it('adds the downloaded track list and looks for the track again', async () => {
    const session = loadSession({ gps: true });
    expect(session.project.track.startFinish).toBeNull();
    api().trackCatalog.mockResolvedValue({
      tracks: [TEST_TRACK],
      source: 'github',
      fetchedAt: '2026-10-26',
    });
    await store().loadTrackCatalog();
    expect(store().trackCatalogSource).toBe('github');
    expect(store().trackCatalog.map((t) => t.id)).toEqual(
      expect.arrayContaining([...TRACK_CATALOG.map((t) => t.id), TEST_TRACK.id]),
    );
    expect(store().project.track.name).toBe('Test Ring');
  });

  it('keeps the bundled list offline', async () => {
    api().trackCatalog.mockRejectedValueOnce(new Error('offline'));
    await store().loadTrackCatalog();
    await store().loadTrackCatalog();
    expect(store().trackCatalogSource).toBe('bundled');
    expect(store().trackCatalog).toHaveLength(TRACK_CATALOG.length);
  });
});

describe('values', () => {
  it('evaluates values at most at 30 fps, tracking requests in flight', async () => {
    const snapshot = valuesSnapshot({ speed: [1, 2] });
    let resolve: (s: typeof snapshot) => void = () => undefined;
    api().evaluateValues.mockReturnValue(new Promise((r) => (resolve = r)));
    const pending = store().refreshValues();
    expect(store().valuesBusy).toBe(true);
    expect(api().evaluateValues).toHaveBeenCalledWith(store().project, 30);
    resolve(snapshot);
    await pending;
    expect(store()).toMatchObject({ values: snapshot, valuesError: null, valuesBusy: false });

    store().setOutput({ frameRate: 25 });
    api().evaluateValues.mockResolvedValue(snapshot);
    await store().refreshValues();
    expect(api().evaluateValues).toHaveBeenLastCalledWith(expect.anything(), 25);
  });

  it('ignores the values of a project that changed meanwhile', async () => {
    let resolve: (s: ReturnType<typeof valuesSnapshot>) => void = () => undefined;
    api().evaluateValues.mockReturnValue(new Promise((r) => (resolve = r)));
    const pending = store().refreshValues();
    store().setName('Changed');
    resolve(valuesSnapshot({ speed: [1] }));
    await pending;
    expect(store().values).toBeNull();
    expect(store().valuesBusy).toBe(false);
  });

  it('reports evaluation errors', async () => {
    api().evaluateValues.mockRejectedValue(new Error('script failed'));
    await store().refreshValues();
    expect(store().valuesError).toBe('script failed');
  });

  it('adds, replaces and deletes value scripts', () => {
    expect(store().saveValueScript(null, script())).toBeNull();
    expect(store().project.values.map((v) => v.id)).toEqual(['speed.double']);
    expect(store().saveValueScript('speed.double', script({ id: 'speed.twice' }))).toBeNull();
    expect(store().project.values.map((v) => v.id)).toEqual(['speed.twice']);
    expect(store().saveValueScript(null, script({ id: 'speed.twice' }))).toBe(
      "A project value with id 'speed.twice' already exists",
    );
    store().deleteValueScript('speed.twice');
    expect(store().project.values).toEqual([]);
  });

  it('rejects invalid scripts with the problems found', () => {
    const message = store().saveValueScript(null, script({ id: '' }));
    expect(message).toMatch(/^id: /);
    expect(store().project.values).toEqual([]);
  });

  it('imports a value collection, replacing values with the same id', async () => {
    store().saveValueScript(null, script({ name: 'Old' }));
    api().openValueCollection.mockResolvedValueOnce({
      version: 1,
      name: 'Pack',
      values: [script({ name: 'New' }), script({ id: 'other' })],
    });
    await store().importValues();
    expect(store().project.values.map((v) => [v.id, v.name])).toEqual([
      ['speed.double', 'New'],
      ['other', 'Double speed'],
    ]);
    expect(store().notice?.message).toBe("Imported 2 values from 'Pack'");
  });

  it('ignores a cancelled import and reports failures', async () => {
    await store().importValues();
    expect(store().notice).toBeNull();
    api().openValueCollection.mockRejectedValue(new Error('bad'));
    await store().importValues();
    expect(store().notice?.message).toBe('Could not import values: bad');
  });

  it('exports the project values as a collection', async () => {
    store().setName('Run');
    store().saveValueScript(null, script());
    await store().exportValues();
    expect(api().saveValueCollection).toHaveBeenCalledWith({
      version: 1,
      name: 'Run values',
      values: [script()],
    });
    api().saveValueCollection.mockRejectedValue(new Error('denied'));
    await store().exportValues();
    expect(store().notice?.message).toBe('Could not export values: denied');
  });
});

describe('widgets', () => {
  const widgets = () => store().project.template.widgets;

  it('adds a widget and selects it', () => {
    store().addWidget('text');
    expect(widgets()).toHaveLength(1);
    expect(store().selectedWidgetId).toBe(widgets()[0]?.id);
  });

  it('updates a widget and its props', () => {
    store().addWidget('text');
    const id = widgets()[0]?.id ?? '';
    store().updateWidget(id, { x: 0.5, name: 'Title' });
    store().setWidgetProps(id, { text: 'Hello' });
    store().updateWidget('missing', { x: 1 });
    store().setWidgetProps('missing', { text: 'Other' });
    expect(widgets()[0]).toMatchObject({ x: 0.5, name: 'Title', props: { text: 'Hello', size: 0.7 } });
  });

  it('removes a widget, clearing the selection only when it was selected', () => {
    store().addWidget('text');
    store().addWidget('shape');
    const [first, second] = widgets().map((w) => w.id);
    store().removeWidget(first ?? '');
    expect(store().selectedWidgetId).toBe(second);
    store().removeWidget(second ?? '');
    expect(store().selectedWidgetId).toBeNull();
    expect(widgets()).toEqual([]);
  });

  it('duplicates a widget next to the original', () => {
    store().addWidget('text');
    const original = widgets()[0];
    store().duplicateWidget(original?.id ?? '');
    const copy = widgets()[1];
    expect(copy?.id).not.toBe(original?.id);
    expect(copy?.x).toBeCloseTo((original?.x ?? 0) + 0.02);
    expect(copy?.y).toBeCloseTo((original?.y ?? 0) + 0.02);
    expect(store().selectedWidgetId).toBe(copy?.id);
    store().duplicateWidget('missing');
    expect(widgets()).toHaveLength(2);
  });

  it('moves widgets to the front or the back within bounds', () => {
    store().addWidget('text');
    store().addWidget('shape');
    const [a, b] = widgets().map((w) => w.id);
    store().moveWidget(a ?? '', 1);
    expect(widgets().map((w) => w.id)).toEqual([b, a]);
    store().moveWidget(a ?? '', 1);
    store().moveWidget(b ?? '', -1);
    store().moveWidget('missing', 1);
    expect(widgets().map((w) => w.id)).toEqual([b, a]);
  });

  it('selects widgets and keeps test values', () => {
    store().selectWidget('w1');
    expect(store().selectedWidgetId).toBe('w1');
    store().setTestValue('speed', 12);
    store().setTestValue('rpm', 5000);
    store().setTestValue('speed', null);
    expect(store().testValues).toEqual({ rpm: 5000 });
  });

  it('imports widgets with fresh ids and selects the last one', async () => {
    const imported = [createWidget('text'), createWidget('shape')];
    api().openWidgets.mockResolvedValueOnce(imported);
    await store().importWidgets();
    expect(widgets().map((w) => w.type)).toEqual(['text', 'shape']);
    expect(widgets().map((w) => w.id)).not.toContain(imported[0]?.id);
    expect(store().selectedWidgetId).toBe(widgets()[1]?.id);
  });

  it('ignores an empty import and reports failures', async () => {
    await store().importWidgets();
    expect(widgets()).toEqual([]);
    api().openWidgets.mockRejectedValue(new Error('bad'));
    await store().importWidgets();
    expect(store().notice?.message).toBe('Could not import widgets: bad');
  });

  it('exports a widget', async () => {
    store().addWidget('text');
    const widget = widgets()[0];
    await store().exportWidget(widget?.id ?? '');
    expect(api().saveWidget).toHaveBeenCalledWith(widget);
    await store().exportWidget('missing');
    expect(api().saveWidget).toHaveBeenCalledTimes(1);
    api().saveWidget.mockRejectedValue(new Error('denied'));
    await store().exportWidget(widget?.id ?? '');
    expect(store().notice?.message).toBe('Could not export the widget: denied');
  });

  it('edits the guides', () => {
    store().setGuides({ columns: 3, margin: 5 });
    expect(store().project.template.guides).toMatchObject({ columns: 3, rows: 0, margin: 5 });
  });
});

describe('editor preferences', () => {
  it('remembers snap and guides on this computer', () => {
    store().setSnap(false);
    store().setShowGuides(false);
    expect(localStorage.getItem('custom-overlay.editor.snap')).toBe('0');
    expect(localStorage.getItem('custom-overlay.editor.guides')).toBe('0');
    store().newProject('Next');
    expect(store()).toMatchObject({ snap: false, showGuides: false });
    store().setSnap(true);
    expect(localStorage.getItem('custom-overlay.editor.snap')).toBe('1');
  });

  it('falls back to the defaults without storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    store().setSnap(false);
    expect(store().snap).toBe(false);
    store().newProject('Next');
    expect(store()).toMatchObject({ snap: true, showGuides: true });
  });

  it('toggles the sample data', () => {
    store().setSampleData(true);
    expect(store().sampleData).toBe(true);
  });
});

describe('navigation and notices', () => {
  it('goes to steps, moves and seeks the playhead', () => {
    store().goTo('template');
    expect(store().step).toBe('template');
    store().setTime(4);
    expect(store()).toMatchObject({ currentTime: 4, seekRequest: null });
    store().seek(10);
    const first = store().seekRequest;
    store().seek(10);
    expect(store().currentTime).toBe(10);
    expect(store().seekRequest?.time).toBe(10);
    expect(store().seekRequest?.id).toBeGreaterThan(first?.id ?? 0);
  });

  it('shows and dismisses notices', () => {
    store().notify('info', 'Hello');
    expect(store().notice).toEqual({ kind: 'info', message: 'Hello' });
    store().dismissNotice();
    expect(store().notice).toBeNull();
  });
});

describe('isBusy', () => {
  it('is busy while exporting, loading media or evaluating values', () => {
    expect(isBusy(store())).toBe(false);
    expect(isBusy({ ...store(), loading: { a: false } })).toBe(false);
    expect(isBusy({ ...store(), loading: { a: true } })).toBe(true);
    expect(isBusy({ ...store(), valuesBusy: true })).toBe(true);
    expect(isBusy({ ...store(), exportState: { status: 'running', progress: null } })).toBe(true);
  });
});

it('keeps clock times of the test session (sanity of the helpers)', () => {
  const session = sessionProject();
  expect(session.series[embeddedSourceId(session.videoId)]?.startEpochMs).toBe(SESSION_EPOCH_MS + 20_000);
});
