import {
  dataRangeKey,
  embeddedSourceId,
  type Project,
  type ProjectMedia,
  ProjectValues,
  type SourceKind,
  type TelemetrySeries,
  type VideoInfo,
  widgetInputs,
} from '@custom-overlay/core';
import type { ValuesSnapshot } from '../shared/api';

/**
 * Media loaded through the IPC handlers, kept by path so value scripts can be evaluated in the
 * main process (the renderer's CSP forbids compiling code).
 */
const videos = new Map<string, { info: VideoInfo; telemetry: TelemetrySeries | null }>();
const sources = new Map<string, TelemetrySeries>();

export function rememberVideo(path: string, info: VideoInfo, telemetry: TelemetrySeries | null): void {
  videos.set(path, { info, telemetry });
}

export function rememberSource(path: string, kind: SourceKind, series: TelemetrySeries): void {
  sources.set(`${kind}:${path}`, series);
}

/** Media of a project, from what the renderer loaded. */
export function projectMedia(project: Project): ProjectMedia {
  const media: { videos: Record<string, VideoInfo>; series: Record<string, TelemetrySeries> } = {
    videos: {},
    series: {},
  };
  for (const video of project.videos) {
    const loaded = videos.get(video.path);
    if (!loaded) continue;
    media.videos[video.id] = loaded.info;
    if (loaded.telemetry) media.series[embeddedSourceId(video.id)] = loaded.telemetry;
  }
  for (const source of project.sources) {
    if (source.videoId !== null) continue;
    const series = sources.get(`${source.kind}:${source.path}`);
    if (series) media.series[source.id] = series;
  }
  return media;
}

/** Whole-session values the renderer needs besides the ranged ones (Track map, lap bounds). */
const FULL_IDS = [
  'latitude',
  'longitude',
  'lap.time',
  'lap.number',
  'imported.lap.time',
  'imported.lap.number',
];

/**
 * Evaluate every value of a project at `frameRate` frames per second: with its data range, plus
 * the whole-session positions and laps, and what widgets with their own data range read.
 */
export function evaluateProjectValues(project: Project, frameRate: number): ValuesSnapshot {
  const values = new ProjectValues(project, projectMedia(project), { frameRate });
  const engine = values.engine;
  const { data, errors } = engine.evaluate();
  const full: Record<string, Float64Array> = {};
  for (const id of FULL_IDS) if (values.full.has(id)) full[id] = values.full.get(id);
  const ranges: Record<string, Record<string, Float64Array>> = {};
  for (const widget of project.template.widgets) {
    const key = dataRangeKey(widget.dataRange);
    if (!key) continue;
    const own = values.engineFor(widget.dataRange);
    const bucket = ranges[key] ?? {};
    ranges[key] = bucket;
    for (const id of widgetInputs(widget)) if (own.has(id)) bucket[id] = own.get(id);
  }
  const resolved = values.resolve(project.dataRange);
  const { start, count } = engine.grid;
  return {
    grid: { start, frameRate, count },
    values: engine.list(),
    data,
    errors,
    full,
    ranges,
    dataRange: resolved.range,
    dataRangeProblems: resolved.problems,
  };
}
