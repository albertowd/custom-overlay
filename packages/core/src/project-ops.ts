import { type Size, sameAspect, widgetFrame } from './export/canvas.js';
import {
  ENCODE_PRESETS,
  encoderForPreset,
  frameRateIn,
  frameSizeFor,
  isYoutubePreset,
  socialTargetOf,
  youtubePresetFor,
  youtubePresetForOutput,
} from './export/presets.js';
import type { VideoInfo } from './media/probe.js';
import type { Palette } from './model/palette.js';
import {
  createId,
  type EncoderSettings,
  embeddedSourceId,
  type OutputSettings,
  type Project,
  type SourceRef,
  type Template,
  type VideoRef,
} from './model/project.js';
import type { SourceKind } from './model/telemetry.js';
import { resizeAroundAnchor } from './widgets/layout.js';
import { getWidgetType } from './widgets/registry.js';

/** Immutable project operations shared by the desktop app and the CLI. */

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function isEmbedded(source: SourceRef): boolean {
  return source.videoId !== null;
}

/** First enabled video, or first enabled standalone source: it sits at timeline time 0. */
export function referenceItem(project: Project): VideoRef | SourceRef | undefined {
  return project.videos.find((v) => v.enabled) ?? project.sources.find((s) => s.enabled && !isEmbedded(s));
}

/**
 * Shift every offset so the reference item sits at 0. Relative positions (and therefore the sync
 * state) are preserved, e.g. when the reference video is removed or disabled.
 */
export function normalizeOffsets(project: Project): Project {
  const reference = referenceItem(project);
  if (!reference) return project;
  const shift = reference.offsetSeconds;
  const shifted = <T extends VideoRef | SourceRef>(item: T): T => ({
    ...item,
    offsetSeconds: item.offsetSeconds - shift,
    synced: item.id === reference.id ? true : item.synced,
  });
  return { ...project, videos: project.videos.map(shifted), sources: project.sources.map(shifted) };
}

/** Output settings matching a video (size, frame rate, colour); the video fit is the user's. */
export function outputFromVideo(info: VideoInfo): Omit<OutputSettings, 'fit'> {
  return { width: info.width, height: info.height, frameRate: info.frameRate, color: info.color };
}

const round4 = (value: number) => Math.round(value * 1e4) / 1e4;

/**
 * Widgets after the canvas changed shape: widgets keeping an aspect ratio (gauges, maps) get the
 * height that keeps it, around their anchor. The others keep their fractions of the frame.
 */
export function fitWidgetsToCanvas(template: Template, from: Size, to: Size): Template {
  if (sameAspect(from, to)) return template;
  const widgets = template.widgets.map((widget) => {
    const ratio = getWidgetType(widget.type)?.aspectRatio;
    if (!ratio) return widget;
    const next = resizeAroundAnchor(widget, widget.width, (widget.width * to.width) / (ratio * to.height));
    return { ...widget, x: round4(next.x), y: round4(next.y), height: round4(next.height) };
  });
  return { ...template, widgets };
}

/**
 * The project with another output, its widgets fitted to the new shape of the frame they are
 * laid out in (the canvas, or the canvas turned back when they turn with the video).
 */
function withOutput(project: Project, output: OutputSettings): Project {
  const template = fitWidgetsToCanvas(project.template, widgetFrame(project.output), widgetFrame(output));
  return { ...project, output, template };
}

/**
 * Output settings; the preset follows them (a YouTube one switches to the nearest resolution and
 * the frame rate's column of the same codec).
 */
export function setOutput(project: Project, patch: Partial<OutputSettings>): Project {
  const output = { ...project.output, ...patch };
  const { encoder } = project.export;
  return {
    ...withOutput(project, output),
    export: {
      ...project.export,
      encoder:
        encoder.preset === 'custom'
          ? encoder
          : encoderForPreset(youtubePresetForOutput(encoder.preset, output), output, encoder.acceleration),
    },
  };
}

/**
 * Choose an encode preset. A YouTube preset also moves the output to its resolution (keeping the
 * orientation and aspect ratio) and frame rate column, e.g. 119.88 fps footage to 59.94 or 29.97.
 * A social preset moves the canvas to its format (1080 × 1920 for TikTok) and frame rate column.
 */
export function applyPreset(
  project: Project,
  presetId: string,
  acceleration: EncoderSettings['acceleration'] = project.export.encoder.acceleration,
): Project {
  const preset = ENCODE_PRESETS.find((p) => p.id === presetId);
  let output = project.output;
  if (preset?.youtube) {
    output = {
      ...output,
      ...frameSizeFor(preset.youtube.lines, output),
      frameRate: frameRateIn(output.frameRate, preset.youtube.frameRate),
    };
  } else if (preset?.social) {
    const { family, frameRate } = preset.social;
    output = {
      ...output,
      width: family.width,
      height: family.height,
      frameRate: frameRateIn(output.frameRate, frameRate),
    };
  }
  return {
    ...withOutput(project, output),
    export: { ...project.export, encoder: encoderForPreset(presetId, output, acceleration) },
  };
}

export interface NewVideo {
  path: string;
  info: VideoInfo;
  hasTelemetry: boolean;
  /** Kind of the video's telemetry (GoPro GPMF or a DJI subtitle file next to it). */
  telemetryKind?: SourceKind;
}

/**
 * Add a video. The first video defines the output format and becomes the timeline reference;
 * its embedded telemetry (if any) is added as an always-in-sync source.
 */
export function addVideo(project: Project, input: NewVideo): { project: Project; video: VideoRef } {
  const isFirst = !project.videos.some((v) => v.enabled);
  const video: VideoRef = {
    id: createId('vid'),
    path: input.path,
    label: fileName(input.path),
    enabled: true,
    offsetSeconds: 0,
    synced: isFirst,
  };
  const sources = isFirst
    ? // Sources were placed relative to the first source: they must be synced to the video now.
      project.sources.map((s) => ({ ...s, synced: false }))
    : [...project.sources];
  if (input.hasTelemetry) {
    sources.push({
      id: embeddedSourceId(video.id),
      kind: input.telemetryKind ?? 'gopro',
      path: input.path,
      label: `${video.label} telemetry`,
      enabled: true,
      offsetSeconds: video.offsetSeconds,
      synced: true,
      videoId: video.id,
    });
  }
  let updated: Project = { ...project, videos: [...project.videos, video], sources };
  if (isFirst) {
    const output = outputFromVideo(input.info);
    const { preset } = updated.export.encoder;
    const social = socialTargetOf(preset);
    if (social) {
      // The canvas stays the platform's; the frame rate goes to the preset's column.
      updated = setOutput(updated, {
        ...output,
        width: social.family.width,
        height: social.family.height,
        frameRate: frameRateIn(output.frameRate, social.frameRate),
      });
    } else if (isYoutubePreset(preset)) {
      // Above 60 fps, a frame rate YouTube plays (119.88 fps footage exports at 59.94); the
      // resolution stays the video's and the preset is the nearest one for the footage.
      if (output.frameRate > 60.5) output.frameRate = frameRateIn(output.frameRate, 'high');
      updated = setOutput(updated, output);
      const { acceleration } = updated.export.encoder;
      updated = {
        ...updated,
        export: {
          ...updated.export,
          encoder: encoderForPreset(youtubePresetFor(updated.output), updated.output, acceleration),
        },
      };
    } else {
      updated = setOutput(updated, output);
    }
  }
  return { project: updated, video };
}

export function removeVideo(project: Project, id: string): Project {
  const updated: Project = {
    ...project,
    videos: project.videos.filter((v) => v.id !== id),
    sources: project.sources.filter((s) => s.videoId !== id),
  };
  return normalizeOffsets(
    updated.videos.length === 0
      ? { ...updated, export: { ...updated.export, mode: 'image-sequence' } }
      : updated,
  );
}

export function setVideoEnabled(project: Project, id: string, enabled: boolean): Project {
  return normalizeOffsets({
    ...project,
    videos: project.videos.map((v) => (v.id === id ? { ...v, enabled } : v)),
    sources: project.sources.map((s) => (s.videoId === id ? { ...s, enabled } : s)),
  });
}

export interface NewSource {
  kind: SourceKind;
  path: string;
  label?: string;
}

export function addSource(project: Project, input: NewSource): { project: Project; source: SourceRef } {
  const source: SourceRef = {
    id: createId('src'),
    kind: input.kind,
    path: input.path,
    label: input.label ?? fileName(input.path),
    enabled: true,
    offsetSeconds: 0,
    synced: false,
    videoId: null,
  };
  const updated = { ...project, sources: [...project.sources, source] };
  // Without videos the first source is the reference.
  return {
    project: normalizeOffsets(updated),
    source: { ...source, synced: referenceItem(updated)?.id === source.id },
  };
}

export function removeSource(project: Project, id: string): Project {
  return normalizeOffsets({ ...project, sources: project.sources.filter((s) => s.id !== id) });
}

export function setSourceEnabled(project: Project, id: string, enabled: boolean): Project {
  return normalizeOffsets({
    ...project,
    sources: project.sources.map((s) => (s.id === id ? { ...s, enabled } : s)),
  });
}

/**
 * Place a video or standalone source on the timeline. Telemetry embedded in a video moves with it.
 */
export function setItemOffset(project: Project, id: string, offsetSeconds: number, synced = true): Project {
  return {
    ...project,
    videos: project.videos.map((v) => (v.id === id ? { ...v, offsetSeconds, synced } : v)),
    sources: project.sources.map((s) => {
      if (s.id === id && !isEmbedded(s)) return { ...s, offsetSeconds, synced };
      if (s.videoId === id) return { ...s, offsetSeconds };
      return s;
    }),
  };
}

export function setItemSynced(project: Project, id: string, synced: boolean): Project {
  return {
    ...project,
    videos: project.videos.map((v) => (v.id === id ? { ...v, synced } : v)),
    sources: project.sources.map((s) => (s.id === id ? { ...s, synced } : s)),
  };
}

export function setPalette(project: Project, patch: Partial<Palette>): Project {
  return { ...project, palette: { ...project.palette, ...patch } };
}
