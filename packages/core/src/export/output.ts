import type { Project } from '../model/project.js';

/**
 * Where an export goes when the user did not choose: next to the media, named after the project.
 * Paths keep the separator style of the media path, so this works the same on every platform.
 */

/** Folder of a path with its trailing separator (`C:\videos\` / `/home/me/`), empty without one. */
function folderOf(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

/** `text` without trailing `chars` (a loop: `/[. ]+$/` backtracks quadratically on long runs). */
function trimEndOf(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text.charAt(end - 1))) end--;
  return text.slice(0, end);
}

/** File name made from the project name, without characters file systems refuse. */
export function outputBaseName(project: Pick<Project, 'name'>): string {
  const cleaned = trimEndOf(
    project.name
      .replace(/[<>:"/\\|?*]/g, ' ')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are not allowed in file names
      .replace(/[\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
    '. ',
  );
  return cleaned || 'overlay';
}

/**
 * Folder of the default output: the first enabled video's, else the first data source's (files
 * of their own, not telemetry inside a video). Null when the project has neither.
 */
export function defaultOutputFolder(project: Pick<Project, 'videos' | 'sources'>): string | null {
  const video = project.videos.find((v) => v.enabled);
  const source = project.sources.find((s) => s.enabled && s.videoId === null);
  const path = video?.path ?? source?.path;
  if (!path) return null;
  const folder = folderOf(path);
  return folder || null;
}

/** `<media folder>/<project name>.mp4`, or a `<project name> frames` folder for image sequences. */
export function defaultOutputPath(
  project: Pick<Project, 'videos' | 'sources' | 'name' | 'export'>,
): string | null {
  const folder = defaultOutputFolder(project);
  if (!folder) return null;
  const name = outputBaseName(project);
  return project.export.mode === 'video' ? `${folder}${name}.mp4` : `${folder}${name} frames`;
}

/** The chosen output path, or the default one. */
export function exportOutputPath(
  project: Pick<Project, 'videos' | 'sources' | 'name' | 'export'>,
): string | null {
  return project.export.outputPath ?? defaultOutputPath(project);
}

/** `race.mp4` → `race (2).mp4`; a folder (`race v1.2 frames`) → `race v1.2 frames (2)`. */
export function numberedPath(path: string, n: number, isFile = true): string {
  const name = path.slice(folderOf(path).length);
  const dot = isFile ? name.lastIndexOf('.') : -1;
  if (dot <= 0) return `${path} (${n})`;
  return `${path.slice(0, path.length - name.length + dot)} (${n})${name.slice(dot)}`;
}
