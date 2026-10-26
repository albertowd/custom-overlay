import { describe, expect, it } from 'vitest';
import { createProject, embeddedSourceId, type Project } from '../src/model/project.js';
import {
  addSource,
  addVideo,
  applyPreset,
  referenceItem,
  removeSource,
  removeVideo,
  setItemOffset,
  setItemSynced,
  setOutput,
  setPalette,
  setSourceEnabled,
  setVideoEnabled,
} from '../src/project-ops.js';
import { autoSyncProject, goproChapter, goproChapterFiles } from '../src/sync/project-sync.js';
import { computeTimeline, itemsRequiringSync, type ProjectMedia, videoAt } from '../src/workflow/timeline.js';
import {
  blockingIssues,
  canEnterStep,
  evaluateWorkflow,
  nextStep,
  previousStep,
  type StepId,
} from '../src/workflow/workflow.js';
import { speedSeries, videoInfo } from './helpers/fixtures.js';

function stateOf(project: Project, id: StepId, failedIds: string[] = []) {
  return evaluateWorkflow({ project, failedIds }).find((s) => s.id === id);
}

function withVideo(project: Project, path: string, hasTelemetry = true) {
  return addVideo(project, { path, info: videoInfo({ path }), hasTelemetry });
}

describe('workflow', () => {
  it('requires a video or a source', () => {
    const statuses = evaluateWorkflow({ project: createProject() });
    expect(statuses.find((s) => s.id === 'videos')?.state).toBe('skipped');
    expect(statuses.find((s) => s.id === 'sources')?.state).toBe('incomplete');
    expect(canEnterStep(statuses, 'sources')).toBe(true);
    expect(canEnterStep(statuses, 'sync')).toBe(false);
    expect(canEnterStep(statuses, 'template')).toBe(true);
    expect(canEnterStep(statuses, 'summary')).toBe(false);
  });

  it('leaves the video export to another host when this one cannot render videos', () => {
    // A web project stores its media by file name: no default output folder.
    const { project } = withVideo(createProject(), 'GX010001.MP4');
    const web = (mode: Project['export']['mode']) =>
      evaluateWorkflow({
        project: { ...project, export: { ...project.export, mode } },
        videoExport: false,
      }).find((s) => s.id === 'export');
    expect(web('video')?.issues.map((i) => [i.code, i.severity])).toEqual([
      ['videoExportElsewhere', 'warning'],
    ]);
    expect(blockingIssues(evaluateWorkflow({ project, videoExport: false }))).toEqual([]);
    // An image sequence is exported here: it needs an output location.
    expect(web('image-sequence')?.issues.map((i) => i.code)).toEqual(['noOutput']);
    // Hosts that render videos (desktop, CLI) are unchanged.
    expect(stateOf(project, 'export')?.issues.map((i) => i.code)).toEqual(['noOutput']);
  });

  it('accepts a single video with embedded telemetry', () => {
    const { project } = withVideo(createProject(), '/v.mp4');
    expect(stateOf(project, 'sources')?.state).toBe('complete');
    expect(stateOf(project, 'sync')?.state).toBe('not-applicable');
    // The export goes next to the video by default: nothing blocks.
    expect(blockingIssues(evaluateWorkflow({ project }))).toEqual([]);
  });

  it('requires every other video and source to be synced', () => {
    let { project } = withVideo(createProject(), '/a.mp4');
    const second = withVideo(project, '/b.mp4');
    project = second.project;
    const log = addSource(project, { kind: 'racechrono', path: '/log.csv' });
    project = log.project;
    expect(itemsRequiringSync(project).map((i) => i.id)).toEqual([second.video.id, log.source.id]);
    expect(stateOf(project, 'sync')?.issues).toHaveLength(2);

    project = setItemOffset(project, second.video.id, 60);
    project = setItemSynced(project, log.source.id, true);
    expect(stateOf(project, 'sync')?.state).toBe('complete');
  });

  it('reports load failures and impossible exports', () => {
    let project = addSource(createProject(), { kind: 'racechrono', path: '/a.csv' }).project;
    project = { ...project, export: { ...project.export, mode: 'video', outputPath: '/out.mp4' } };
    const id = project.sources[0]?.id ?? '';
    expect(stateOf(project, 'sources', [id])?.issues[0]?.message).toMatch(/could not be loaded/);
    expect(stateOf(project, 'export')?.issues[0]?.message).toMatch(/requires a source video/);

    const video = withVideo(createProject(), '/v.mp4', false);
    expect(stateOf(video.project, 'videos', [video.video.id])?.state).toBe('incomplete');
    expect(stateOf(video.project, 'sources')?.issues[0]?.message).toMatch(/no embedded telemetry/);
  });

  it('navigates steps in order', () => {
    expect(nextStep('videos')).toBe('sources');
    expect(nextStep('export')).toBeNull();
    expect(previousStep('videos')).toBeNull();
    expect(previousStep('sync')).toBe('sources');
  });
});

describe('project operations', () => {
  it('takes the output format from the first video', () => {
    const { project } = addVideo(createProject(), {
      path: '/v.mp4',
      info: videoInfo({ width: 2704, height: 1520, frameRate: 50 }),
      hasTelemetry: false,
    });
    expect(project.output).toEqual({
      width: 2704,
      height: 1520,
      frameRate: 50,
      color: { space: 'rec709', range: 'full', bitDepth: 10 },
      fit: { mode: 'contain', rotation: 0, rotateWidgets: false, zoom: 1, x: 0.5, y: 0.5 },
    });
    // The YouTube preset follows the footage: 10-bit SDR goes HEVC, 2.7K is nearest to 1440p.
    expect(project.export.encoder).toMatchObject({
      preset: 'youtube-sdr-hevc-1440p60',
      codec: 'hevc',
      bitrateMbps: 24,
    });
    const second = addVideo(project, { path: '/b.mp4', info: videoInfo(), hasTelemetry: false }).project;
    expect(second.output.width).toBe(2704);
  });

  it('defaults to 1080p60 Rec.709 and keeps custom encoders', () => {
    const project = createProject();
    expect(project.output).toEqual({
      width: 1920,
      height: 1080,
      frameRate: 60,
      color: { space: 'rec709', range: 'limited', bitDepth: 8 },
      fit: { mode: 'contain', rotation: 0, rotateWidgets: false, zoom: 1, x: 0.5, y: 0.5 },
    });
    const custom = {
      ...project,
      export: {
        ...project.export,
        encoder: { ...project.export.encoder, preset: 'custom', bitrateMbps: 99 },
      },
    };
    expect(setOutput(custom, { width: 3840, height: 2160 }).export.encoder.bitrateMbps).toBe(99);
    expect(setOutput(project, { width: 3840, height: 2160 }).export.encoder.bitrateMbps).toBe(68);
  });

  it('keeps YouTube presets and the output format together', () => {
    // 119.88 fps footage: YouTube plays 60 fps at most; the resolution stays the video's.
    const { project } = addVideo(createProject(), {
      path: '/v.mp4',
      info: videoInfo({ width: 3840, height: 2160, frameRate: 119.88 }),
      hasTelemetry: false,
    });
    expect(project.output).toMatchObject({ width: 3840, height: 2160, frameRate: 59.94 });
    expect(project.export.encoder).toMatchObject({ preset: 'youtube-sdr-hevc-2160p60', bitrateMbps: 68 });
    // Choosing a preset moves the output to its resolution and frame rate.
    const hd = applyPreset(project, 'youtube-sdr-hevc-1080p30');
    expect(hd.output).toMatchObject({ width: 1920, height: 1080, frameRate: 29.97 });
    expect(hd.export.encoder).toMatchObject({ preset: 'youtube-sdr-hevc-1080p30', bitrateMbps: 8 });
    // Editing the output switches to the nearest preset of the same codec; others keep the format.
    expect(setOutput(hd, { frameRate: 50 }).export.encoder.preset).toBe('youtube-sdr-hevc-1080p60');
    expect(setOutput(hd, { width: 1280, height: 720 }).export.encoder.preset).toBe('youtube-sdr-hevc-720p30');
    expect(applyPreset(hd, 'archive').output).toMatchObject({ width: 1920, frameRate: 29.97 });
  });

  it('moves embedded telemetry with its video', () => {
    let { project } = withVideo(createProject(), '/a.mp4');
    const b = withVideo(project, '/b.mp4');
    project = setItemOffset(b.project, b.video.id, 42);
    expect(project.sources.find((s) => s.id === embeddedSourceId(b.video.id))?.offsetSeconds).toBe(42);
  });

  it('re-anchors offsets when the reference goes away', () => {
    let { project, video: a } = withVideo(createProject(), '/a.mp4');
    const b = withVideo(project, '/b.mp4');
    project = setItemOffset(b.project, b.video.id, 60);
    const log = addSource(project, { kind: 'racechrono', path: '/log.csv' });
    project = setItemOffset(log.project, log.source.id, 30);

    const without = removeVideo(project, a.id);
    expect(referenceItem(without)?.id).toBe(b.video.id);
    expect(without.videos[0]).toMatchObject({ offsetSeconds: 0, synced: true });
    expect(without.sources.find((s) => s.id === log.source.id)?.offsetSeconds).toBe(-30);

    const disabled = setVideoEnabled(project, a.id, false);
    expect(referenceItem(disabled)?.id).toBe(b.video.id);
    expect(removeVideo(without, b.video.id).export.mode).toBe('image-sequence');
  });

  it('uses the first source as reference without videos', () => {
    let { project, source: a } = addSource(createProject(), { kind: 'racechrono', path: '/a.csv' });
    expect(a.synced).toBe(true);
    const b = addSource(project, { kind: 'racechrono', path: '/b.csv' });
    project = setItemOffset(b.project, b.source.id, 5);
    expect(itemsRequiringSync(project).map((s) => s.id)).toEqual([b.source.id]);
    expect(referenceItem(setSourceEnabled(project, a.id, false))?.id).toBe(b.source.id);
    expect(removeSource(project, a.id).sources[0]?.offsetSeconds).toBe(0);
  });

  it('edits the palette', () => {
    expect(setPalette(createProject(), { primary: '#123456' }).palette.primary).toBe('#123456');
  });
});

describe('timeline', () => {
  it('spans every video and source', () => {
    let { project, video: a } = withVideo(createProject(), '/a.mp4');
    const b = withVideo(project, '/b.mp4');
    project = setItemOffset(b.project, b.video.id, 60);
    const log = addSource(project, { kind: 'racechrono', path: '/log.csv' });
    project = setItemOffset(log.project, log.source.id, -20);
    const media: ProjectMedia = {
      videos: { [a.id]: videoInfo(), [b.video.id]: videoInfo({ durationSeconds: 30 }) },
      series: {
        [embeddedSourceId(a.id)]: speedSeries(0, 60, 10, 1_000_000, 'gopro'),
        [log.source.id]: speedSeries(0, 200, 10, null),
      },
    };
    const timeline = computeTimeline(project, media);
    expect(timeline).toMatchObject({
      basis: 'video',
      start: -20,
      end: 179.9,
      width: 3840,
      startEpochMs: 1_000_000,
    });
    expect(videoAt(project, media, 70)).toMatchObject({ video: { id: b.video.id }, videoTime: 10 });
    expect(videoAt(project, media, 95)).toBeNull();
    expect(computeTimeline(createProject(), { videos: {}, series: {} }).basis).toBe('none');
  });
});

describe('project sync', () => {
  it('chains GoPro chapters and syncs data sources against them', () => {
    let project = createProject();
    const ids: string[] = [];
    for (const name of ['GX020042.MP4', 'GX010042.MP4', 'GX030042.MP4']) {
      const added = withVideo(project, `/media/${name}`, false);
      project = added.project;
      ids.push(added.video.id);
    }
    // GX02 was added first so it is the reference: GX01 goes right before it, GX03 right after.
    const media: ProjectMedia = {
      videos: Object.fromEntries(ids.map((id) => [id, videoInfo({ durationSeconds: 100 })])),
      series: {},
    };
    const { project: synced, results } = autoSyncProject(project, media);
    expect(results.map((r) => r.result?.method)).toEqual(['chapter', 'chapter']);
    expect(synced.videos.map((v) => [v.label, v.offsetSeconds, v.synced])).toEqual([
      ['GX020042.MP4', 0, true],
      ['GX010042.MP4', -100, true],
      ['GX030042.MP4', 100, true],
    ]);
    // Same folder: one recording, so the chapter beats any signal match.
    expect(results.map((r) => r.result?.confidence)).toEqual([1, 1]);
  });

  it('trusts chapter names less across folders (another camera)', () => {
    let project = createProject();
    const ids: string[] = [];
    for (const path of ['/cam-a/GX010042.MP4', '/cam-b/GX020042.MP4']) {
      const added = withVideo(project, path, false);
      project = added.project;
      ids.push(added.video.id);
    }
    const media: ProjectMedia = {
      videos: Object.fromEntries(ids.map((id) => [id, videoInfo({ durationSeconds: 100 })])),
      series: {},
    };
    const { results } = autoSyncProject(project, media);
    expect(results[0]?.result).toMatchObject({ method: 'chapter', offsetSeconds: 100, confidence: 0.95 });
  });

  it('parses GoPro file names', () => {
    expect(goproChapter('C:\\x\\GX030042.MP4')).toEqual({ clip: 'X0042', chapter: 3 });
    expect(goproChapter('GOPR0042.MP4')).toEqual({ clip: 'GP0042', chapter: 0 });
    expect(goproChapter('GP010042.MP4')).toEqual({ clip: 'GP0042', chapter: 1 });
    expect(goproChapter('holiday.mp4')).toBeNull();
  });

  it('finds every chapter of a GoPro recording in its folder', () => {
    const folder = [
      'GX030042.MP4',
      'GX010042.MP4',
      'GX010042.LRV',
      'GX020042.MP4',
      'GX010043.MP4',
      'notes.txt',
    ];
    expect(goproChapterFiles('D:\\gopro\\GX020042.MP4', folder)).toEqual([
      'D:\\gopro\\GX010042.MP4',
      'D:\\gopro\\GX020042.MP4',
      'D:\\gopro\\GX030042.MP4',
    ]);
    expect(goproChapterFiles('/media/GOPR0042.MP4', ['GP010042.MP4', 'GOPR0042.MP4'])).toEqual([
      '/media/GOPR0042.MP4',
      '/media/GP010042.MP4',
    ]);
    expect(goproChapterFiles('/media/holiday.mp4', ['holiday.mp4'])).toEqual([]);
    expect(goproChapterFiles('/media/GX010042.LRV', folder)).toEqual([]);
  });

  it('syncs a logger against the embedded telemetry and marks only confident results', () => {
    let { project, video } = withVideo(createProject(), '/v.mp4');
    const log = addSource(project, { kind: 'racechrono', path: '/log.csv' });
    project = log.project;
    const media: ProjectMedia = {
      videos: { [video.id]: videoInfo({ durationSeconds: 120 }) },
      series: {
        [embeddedSourceId(video.id)]: speedSeries(100, 120, 18, 1_000_000, 'gopro'),
        [log.source.id]: speedSeries(0, 400, 25, 1_000_000 - 100_000),
      },
    };
    const report = autoSyncProject(project, media);
    expect(report.results[0]?.candidates.map((c) => c.method)).toEqual(['correlation', 'timestamp']);
    expect(report.project.sources.find((s) => s.id === log.source.id)).toMatchObject({ synced: true });
    expect(report.project.sources.find((s) => s.id === log.source.id)?.offsetSeconds).toBeCloseTo(-100, 1);

    // Nothing else to do unless forced
    expect(autoSyncProject(report.project, media).results).toEqual([]);
    expect(autoSyncProject(report.project, media, true).results).toHaveLength(1);
  });
});
