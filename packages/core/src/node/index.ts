import { type FileHandle, open, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { detectSourceKind, trackFromData, widgetsFromData } from '../io/files.js';
import type { RandomAccessReader } from '../io/reader.js';
import { type FindSubtitles, type LoadedVideo, loadSourceFrom, loadVideoFrom } from '../loaders/index.js';
import { parseMp4 } from '../media/mp4.js';
import { type VideoInfo, videoInfoFromMp4 } from '../media/probe.js';
import {
  embeddedSourceId,
  type Project,
  parseProject,
  parseTemplate,
  parseValueCollection,
  type SourceRef,
  serializeProject,
  serializeTemplate,
  serializeTrackFile,
  serializeValueCollection,
  serializeWidgetFile,
  type Template,
} from '../model/project.js';
import type { TelemetrySeries } from '../model/telemetry.js';
import type { Track } from '../model/track.js';
import type { ValueCollection } from '../model/values.js';
import type { Widget } from '../model/widget.js';
import type { ProjectMedia } from '../workflow/timeline.js';

export { detectSourceKind } from '../io/files.js';
export { goproDevicesToSeries, type LoadedVideo, parseGoProTelemetry } from '../loaders/index.js';
export * from './export.js';
export { type ExportWorkerRequest, type ExportWorkerResponse, runExportWorker } from './export-worker.js';

/** Random access reader over a file on disk. */
export class NodeFileReader implements RandomAccessReader {
  private constructor(
    private readonly handle: FileHandle,
    readonly size: number,
  ) {}

  static async open(path: string): Promise<NodeFileReader> {
    const handle = await open(path, 'r');
    const { size } = await handle.stat();
    return new NodeFileReader(handle, size);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const size = Math.max(0, Math.min(length, this.size - offset));
    const buffer = new Uint8Array(size);
    let done = 0;
    while (done < size) {
      const { bytesRead } = await this.handle.read(buffer, done, size - done, offset + done);
      if (bytesRead === 0) break;
      done += bytesRead;
    }
    return done === size ? buffer : buffer.subarray(0, done);
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

async function withReader<T>(path: string, fn: (reader: NodeFileReader) => Promise<T>): Promise<T> {
  const reader = await NodeFileReader.open(path);
  try {
    return await fn(reader);
  } finally {
    await reader.close();
  }
}

/** The DJI telemetry subtitles next to a video (same name, `.srt` in any case), if any. */
export async function findDjiSubtitles(videoPath: string): Promise<string | null> {
  const dir = dirname(videoPath);
  const stem = basename(videoPath, extname(videoPath)).toLowerCase();
  const names = await readdir(dir).catch(() => [] as string[]);
  const match = names.find((n) => n.toLowerCase() === `${stem}.srt`);
  return match ? join(dir, match) : null;
}

const subtitlesNextTo =
  (videoPath: string): FindSubtitles =>
  async () => {
    const path = await findDjiSubtitles(videoPath);
    return path ? { name: basename(path), text: await readFile(path, 'utf8') } : null;
  };

export async function probeVideoFile(path: string): Promise<VideoInfo> {
  return withReader(path, async (reader) => videoInfoFromMp4(await parseMp4(reader), path, reader.size));
}

export async function loadVideo(path: string): Promise<LoadedVideo> {
  return withReader(path, (reader) => loadVideoFrom(reader, path, subtitlesNextTo(path)));
}

export async function loadSourceFile(path: string, kind = detectSourceKind(path)): Promise<TelemetrySeries> {
  return loadSourceFrom(
    {
      name: basename(path),
      readText: () => readFile(path, 'utf8'),
      withReader: (read) => withReader(path, read),
      findSubtitles: subtitlesNextTo(path),
    },
    kind,
  );
}

export async function loadSource(source: SourceRef): Promise<TelemetrySeries> {
  return loadSourceFile(source.path, source.kind);
}

export interface LoadedProjectMedia extends ProjectMedia {
  videos: Record<string, VideoInfo>;
  /** Loaded telemetry by source id (embedded telemetry included). */
  series: Record<string, TelemetrySeries>;
  /** Load errors by video or source id. */
  errors: Record<string, string>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Load every enabled video and source of a project; failures are reported, not thrown. */
export async function loadProjectMedia(project: Project): Promise<LoadedProjectMedia> {
  const media: LoadedProjectMedia = { videos: {}, series: {}, errors: {} };
  for (const video of project.videos.filter((v) => v.enabled)) {
    try {
      const loaded = await loadVideo(video.path);
      media.videos[video.id] = loaded.info;
      if (loaded.telemetry) media.series[embeddedSourceId(video.id)] = loaded.telemetry;
    } catch (error) {
      media.errors[video.id] = errorMessage(error);
    }
  }
  for (const source of project.sources.filter((s) => s.enabled)) {
    if (source.videoId !== null) {
      if (!media.series[source.id] && !media.errors[source.videoId]) {
        media.errors[source.id] = 'The video has no embedded telemetry';
      }
      continue;
    }
    try {
      media.series[source.id] = await loadSource(source);
    } catch (error) {
      media.errors[source.id] = errorMessage(error);
    }
  }
  return media;
}

/** Paths are stored relative to the project file so projects can be moved with their media. */
function toStoredPath(path: string, baseDir: string): string {
  const rel = relative(baseDir, path);
  return rel === '' || isAbsolute(rel) ? path : rel.split('\\').join('/');
}

function toAbsolutePath(path: string, baseDir: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

function mapProjectPaths(project: Project, map: (path: string) => string): Project {
  return {
    ...project,
    videos: project.videos.map((v) => ({ ...v, path: map(v.path) })),
    sources: project.sources.map((s) => ({ ...s, path: map(s.path) })),
    templatePath: project.templatePath ? map(project.templatePath) : null,
    export: {
      ...project.export,
      outputPath: project.export.outputPath ? map(project.export.outputPath) : null,
    },
  };
}

/** Read a project file; returned paths are absolute. */
export async function readProjectFile(path: string): Promise<Project> {
  const project = parseProject(JSON.parse(await readFile(path, 'utf8')));
  const baseDir = dirname(resolve(path));
  return mapProjectPaths(project, (p) => toAbsolutePath(p, baseDir));
}

export async function writeProjectFile(path: string, project: Project): Promise<void> {
  const baseDir = dirname(resolve(path));
  await writeFile(path, serializeProject(mapProjectPaths(project, (p) => toStoredPath(p, baseDir))), 'utf8');
}

export async function readTemplateFile(path: string): Promise<Template> {
  return parseTemplate(JSON.parse(await readFile(path, 'utf8')));
}

export async function writeTemplateFile(path: string, template: Template): Promise<void> {
  await writeFile(path, serializeTemplate(template), 'utf8');
}

/** Template used by a project: the external file when set, the inline one otherwise. */
export async function resolveProjectTemplate(project: Project): Promise<Template> {
  return project.templatePath ? readTemplateFile(project.templatePath) : project.template;
}

export async function readValueCollection(path: string): Promise<ValueCollection> {
  return parseValueCollection(JSON.parse(await readFile(path, 'utf8')));
}

export async function writeValueCollection(path: string, collection: ValueCollection): Promise<void> {
  await writeFile(path, serializeValueCollection(collection), 'utf8');
}

/** Track lines of a track file (`*.track.json`) or of another project, to reuse them. */
export async function readTrack(path: string): Promise<Track> {
  return trackFromData(JSON.parse(await readFile(path, 'utf8')));
}

export async function writeTrackFile(path: string, track: Track): Promise<void> {
  await writeFile(path, serializeTrackFile({ version: 1, track }), 'utf8');
}

/**
 * Widgets of a file: a single widget (`*.widget.json`) or every widget of a template
 * (`*.template.json`), e.g. to merge a collection into the current template.
 */
export async function readWidgets(path: string): Promise<Widget[]> {
  return widgetsFromData(JSON.parse(await readFile(path, 'utf8')));
}

export async function writeWidgetFile(path: string, widget: Widget): Promise<void> {
  await writeFile(path, serializeWidgetFile({ version: 1, widget }), 'utf8');
}
