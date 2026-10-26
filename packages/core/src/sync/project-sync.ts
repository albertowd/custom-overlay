import type { Project, SourceRef, VideoRef } from '../model/project.js';
import { embeddedSourceId } from '../model/project.js';
import { getChannel, StandardChannel } from '../model/telemetry.js';
import { isEmbedded, referenceItem, setItemOffset } from '../project-ops.js';
import {
  enabledSources,
  enabledVideos,
  itemRange,
  itemsRequiringSync,
  type ProjectMedia,
} from '../workflow/timeline.js';
import {
  AUTO_SYNC_MIN_CONFIDENCE,
  autoSync,
  type PlacedSubject,
  type SyncCandidate,
  type SyncResult,
  type SyncSubject,
} from './sync.js';

export interface ProjectSyncOptions {
  /** Timezone assumed for camera clocks. Defaults to this machine's. */
  timezoneOffsetMinutes?: number;
}

type Item = VideoRef | SourceRef;

function isSource(item: Item): item is SourceRef {
  return 'kind' in item;
}

function findItem(project: Project, id: string): Item | undefined {
  return project.videos.find((v) => v.id === id) ?? project.sources.find((s) => s.id === id);
}

/** Sync view of a video (with its embedded telemetry) or a standalone source. */
export function syncSubject(media: ProjectMedia, item: Item): SyncSubject | null {
  const range = itemRange(item, media);
  if (!range) return null;
  const telemetry = media.series[isSource(item) ? item.id : embeddedSourceId(item.id)];
  return {
    label: item.label,
    startEpochMs: telemetry?.startEpochMs ?? null,
    clock: isSource(item) ? undefined : media.videos[item.id]?.clock,
    range,
    speed: telemetry ? getChannel(telemetry, StandardChannel.speed) : undefined,
  };
}

/** Items whose position is known: the reference and every synced item. */
function placedSubjects(project: Project, media: ProjectMedia, excludeId: string): PlacedSubject[] {
  const reference = referenceItem(project);
  const items: Item[] = [...enabledVideos(project), ...enabledSources(project).filter((s) => !isEmbedded(s))];
  return items
    .filter((item) => item.id !== excludeId && (item.synced || item.id === reference?.id))
    .sort((a, b) => Number(b.id === reference?.id) - Number(a.id === reference?.id))
    .flatMap((item) => {
      const subject = syncSubject(media, item);
      return subject ? [{ ...subject, offsetSeconds: item.offsetSeconds }] : [];
    });
}

/** GoPro file naming: GX010042.MP4 is chapter 1 of clip 0042; GOPR0042 / GP010042 on older models. */
export function goproChapter(path: string): { clip: string; chapter: number } | null {
  const name = path.split(/[\\/]/).pop() ?? path;
  const modern = /^G([HXL])(\d{2})(\d{4})\.(mp4|lrv)$/i.exec(name);
  if (modern) return { clip: `${modern[1]?.toUpperCase()}${modern[3]}`, chapter: Number(modern[2]) };
  const first = /^GOPR(\d{4})\.mp4$/i.exec(name);
  if (first) return { clip: `GP${first[1]}`, chapter: 0 };
  const next = /^GP(\d{2})(\d{4})\.mp4$/i.exec(name);
  if (next) return { clip: `GP${next[2]}`, chapter: Number(next[1]) };
  return null;
}

/**
 * Every chapter of the GoPro recording a video belongs to, from the file names of its folder, in
 * recording order (the video itself included). Empty when the file is not a GoPro chapter.
 */
export function goproChapterFiles(path: string, folderFiles: readonly string[]): string[] {
  const chapter = goproChapter(path);
  if (!chapter || !/\.mp4$/i.test(path)) return [];
  // Folder with its trailing separator, as written in the path.
  const folder = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  return folderFiles
    .filter((name) => /\.mp4$/i.test(name))
    .map((name) => ({ name, info: goproChapter(name) }))
    .filter(({ info }) => info?.clip === chapter.clip)
    .sort((a, b) => (a.info?.chapter ?? 0) - (b.info?.chapter ?? 0))
    .map(({ name }) => `${folder}${name}`);
}

const folderOf = (path: string) =>
  path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).toLowerCase();

/**
 * A chapter starts exactly where the previous chapter of the same clip ends. Certain for chapters
 * in the same folder (one recording, contiguous by construction, so it beats any signal match);
 * elsewhere the same names may come from another camera.
 */
function chapterCandidate(project: Project, media: ProjectMedia, video: VideoRef): SyncCandidate | null {
  const chapter = goproChapter(video.path);
  if (!chapter) return null;
  const confidence = (other: VideoRef) => (folderOf(other.path) === folderOf(video.path) ? 1 : 0.95);
  const reference = referenceItem(project);
  const placedChapter = (number: number) =>
    enabledVideos(project).find((v) => {
      const other = goproChapter(v.path);
      return (
        v.id !== video.id &&
        (v.synced || v.id === reference?.id) &&
        other?.clip === chapter.clip &&
        other.chapter === number
      );
    });

  const previous = placedChapter(chapter.chapter - 1);
  const previousInfo = previous ? media.videos[previous.id] : undefined;
  if (previous && previousInfo) {
    return {
      method: 'chapter',
      offsetSeconds: previous.offsetSeconds + previousInfo.durationSeconds,
      confidence: confidence(previous),
      code: 'chapterContinues',
      params: { label: previous.label, chapter: chapter.chapter },
      message: `Continues '${previous.label}' (GoPro chapter ${chapter.chapter})`,
    };
  }
  const next = placedChapter(chapter.chapter + 1);
  const ownInfo = media.videos[video.id];
  if (next && ownInfo) {
    return {
      method: 'chapter',
      offsetSeconds: next.offsetSeconds - ownInfo.durationSeconds,
      confidence: confidence(next),
      code: 'chapterEndsBefore',
      params: { label: next.label, chapter: chapter.chapter },
      message: `Ends where '${next.label}' starts (GoPro chapter ${chapter.chapter})`,
    };
  }
  return null;
}

/** Candidate positions of a video or standalone source, best first. */
export function autoSyncItem(
  project: Project,
  media: ProjectMedia,
  itemId: string,
  options: ProjectSyncOptions = {},
): SyncResult[] {
  const item = findItem(project, itemId);
  if (!item) return [];
  const target = syncSubject(media, item);
  if (!target) return [];
  const chapter = isSource(item) ? null : chapterCandidate(project, media, item);
  return autoSync({
    placed: placedSubjects(project, media, itemId),
    target,
    timezoneOffsetMinutes: options.timezoneOffsetMinutes,
    extra: chapter ? [chapter] : [],
  });
}

/** Apply a sync result; it only counts as synced when confident enough to skip a review. */
export function applySyncResult(project: Project, itemId: string, result: SyncResult): Project {
  return setItemOffset(project, itemId, result.offsetSeconds, result.confidence >= AUTO_SYNC_MIN_CONFIDENCE);
}

export interface ItemSyncOutcome {
  itemId: string;
  label: string;
  /** Best candidate (applied), null when no strategy worked. */
  result: SyncResult | null;
  candidates: SyncResult[];
}

export interface ProjectSyncReport {
  project: Project;
  results: ItemSyncOutcome[];
}

/** Chapters in order, then other videos, then data sources: each synced item helps the next. */
function syncOrder(items: Item[]): Item[] {
  const rank = (item: Item) => {
    if (isSource(item)) return [2, 0] as const;
    const chapter = goproChapter(item.path);
    return [chapter ? 0 : 1, chapter?.chapter ?? 0] as const;
  };
  return [...items].sort((a, b) => {
    const [ga, ca] = rank(a);
    const [gb, cb] = rank(b);
    return ga - gb || ca - cb;
  });
}

/** Auto sync every item that is not synced yet (or all of them with `force`). */
export function autoSyncProject(
  project: Project,
  media: ProjectMedia,
  force = false,
  options: ProjectSyncOptions = {},
): ProjectSyncReport {
  let updated = project;
  const results: ItemSyncOutcome[] = [];
  const pending = syncOrder(itemsRequiringSync(project)).filter(
    (item) => (force || !item.synced) && itemRange(item, media),
  );
  if (force) {
    // Re-place everything from scratch, relative to the reference only.
    for (const item of pending) updated = setItemOffset(updated, item.id, item.offsetSeconds, false);
  }
  for (const item of pending) {
    const candidates = autoSyncItem(updated, media, item.id, options);
    const [best = null] = candidates;
    if (best) updated = applySyncResult(updated, item.id, best);
    results.push({ itemId: item.id, label: item.label, result: best, candidates });
  }
  return { project: updated, results };
}
