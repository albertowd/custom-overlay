// File helpers that need no file system: what a file is, and what a parsed file holds.

import { parseProject, parseTemplate, parseTrackFile, parseWidgetFile } from '../model/project.js';
import type { SourceKind } from '../model/telemetry.js';
import type { Track } from '../model/track.js';
import type { Widget } from '../model/widget.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.lrv', '.360']);

/** Kind of data source of a file, from its extension; null when unsupported. */
export function detectSourceKind(path: string): SourceKind | null {
  const ext = /\.[^./\\]*$/.exec(path)?.[0].toLowerCase() ?? '';
  if (ext === '.csv') return 'racechrono';
  if (ext === '.srt') return 'dji';
  if (VIDEO_EXTENSIONS.has(ext)) return 'gopro';
  return null;
}

/** Track lines of a parsed track file (`*.track.json`) or of another project, to reuse them. */
export function trackFromData(data: unknown): Track {
  if (typeof data === 'object' && data !== null && 'videos' in data) return parseProject(data).track;
  return parseTrackFile(data).track;
}

/**
 * Widgets of a parsed file: a single widget (`*.widget.json`) or every widget of a template
 * (`*.template.json`), e.g. to merge a collection into the current template.
 */
export function widgetsFromData(data: unknown): Widget[] {
  if (typeof data === 'object' && data !== null && 'widget' in data) return [parseWidgetFile(data).widget];
  return parseTemplate(data).widgets;
}
