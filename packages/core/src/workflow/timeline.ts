import type { VideoInfo } from '../media/probe.js';
import type { ColorSettings, Project, SourceRef, VideoRef } from '../model/project.js';
import { seriesTimeRange, type TelemetrySeries } from '../model/telemetry.js';
import { isEmbedded, referenceItem } from '../project-ops.js';

/** Loaded media of a project: video info by video id, telemetry by source id. */
export interface ProjectMedia {
  videos: Readonly<Record<string, VideoInfo | undefined>>;
  series: Readonly<Record<string, TelemetrySeries | undefined>>;
}

export interface Timeline {
  /** What sits at time 0: the first video, the first data source, or nothing yet. */
  basis: 'video' | 'source' | 'none';
  referenceId: string | null;
  /** Earliest start / latest end of every enabled video and source, in timeline seconds. */
  start: number;
  end: number;
  durationSeconds: number;
  width: number;
  height: number;
  frameRate: number;
  color: ColorSettings;
  /** UTC instant of timeline time 0, when any placed item knows absolute time. */
  startEpochMs: number | null;
}

export function enabledVideos(project: Project): VideoRef[] {
  return project.videos.filter((v) => v.enabled);
}

export function enabledSources(project: Project): SourceRef[] {
  return project.sources.filter((s) => s.enabled);
}

/** Videos and standalone sources whose position must be found (all but the reference). */
export function itemsRequiringSync(project: Project): (VideoRef | SourceRef)[] {
  const reference = referenceItem(project);
  return [...enabledVideos(project), ...enabledSources(project).filter((s) => !isEmbedded(s))].filter(
    (item) => item.id !== reference?.id,
  );
}

/** Time range of an item in its own time, null while its media is not loaded. */
export function itemRange(
  item: VideoRef | SourceRef,
  media: ProjectMedia,
): { start: number; end: number } | null {
  if ('kind' in item) {
    const series = media.series[item.id];
    return series ? seriesTimeRange(series) : null;
  }
  const info = media.videos[item.id];
  return info ? { start: 0, end: info.durationSeconds } : null;
}

/** UTC of timeline time 0 from the reference, or any synced item with absolute time. */
function timelineEpoch(project: Project, media: ProjectMedia): number | null {
  const reference = referenceItem(project);
  const placed = enabledSources(project)
    .filter((s) => s.synced || s.id === reference?.id || s.videoId === reference?.id)
    .sort((a, b) => Number(b.videoId === reference?.id) - Number(a.videoId === reference?.id));
  for (const source of placed) {
    const epoch = media.series[source.id]?.startEpochMs;
    if (epoch != null) return epoch - source.offsetSeconds * 1000;
  }
  return null;
}

export function computeTimeline(project: Project, media: ProjectMedia): Timeline {
  const reference = referenceItem(project);
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const item of [...enabledVideos(project), ...enabledSources(project)]) {
    const range = itemRange(item, media);
    if (!range) continue;
    start = Math.min(start, range.start + item.offsetSeconds);
    end = Math.max(end, range.end + item.offsetSeconds);
  }
  if (!Number.isFinite(start)) {
    start = 0;
    end = 0;
  }
  const { output } = project;
  let basis: Timeline['basis'] = 'none';
  if (reference) basis = 'kind' in reference ? 'source' : 'video';
  return {
    basis,
    referenceId: reference?.id ?? null,
    start,
    end,
    durationSeconds: end - start,
    width: output.width,
    height: output.height,
    frameRate: output.frameRate,
    color: output.color,
    startEpochMs: timelineEpoch(project, media),
  };
}

/** Enabled videos covering a timeline time, first match first. */
export function videoAt(
  project: Project,
  media: ProjectMedia,
  time: number,
): { video: VideoRef; info: VideoInfo; videoTime: number } | null {
  for (const video of enabledVideos(project)) {
    const info = media.videos[video.id];
    if (!info) continue;
    const videoTime = time - video.offsetSeconds;
    if (videoTime >= 0 && videoTime < info.durationSeconds) return { video, info, videoTime };
  }
  return null;
}
