import { z } from 'zod';
import { ENCODE_PRESETS, encoderForPreset } from '../export/presets.js';
import { DataRangeSchema } from './data-range.js';
import { PaletteSchema } from './palette.js';
import { type TrackFile, TrackFileSchema, TrackSchema } from './track.js';
import { type ValueCollection, ValueCollectionSchema, ValueScriptSchema } from './values.js';
import { VisibleRangeSchema, type WidgetFile, WidgetFileSchema, WidgetSchema } from './widget.js';

export const PROJECT_FILE_EXTENSION = '.overlay.json';
export const TEMPLATE_FILE_EXTENSION = '.template.json';

export const SourceKindSchema = z.enum(['gopro', 'racechrono', 'dji']);

/** Fields shared by everything placed on the timeline (videos and data sources). */
const timelineItem = {
  id: z.string().min(1),
  path: z.string().min(1),
  label: z.string(),
  enabled: z.boolean().default(true),
  /** Timeline time of the item's time 0: `timelineTime = itemTime + offsetSeconds`. */
  offsetSeconds: z.number().default(0),
  /** True once the offset was confirmed by the user or computed with enough confidence. */
  synced: z.boolean().default(false),
};

export const VideoRefSchema = z.object(timelineItem);

export const SourceRefSchema = z.object({
  ...timelineItem,
  kind: SourceKindSchema,
  /** Id of the video this telemetry is embedded in; it then always follows that video's offset. */
  videoId: z.string().nullable().default(null),
});

export const ColorSettingsSchema = z.object({
  /** Primaries + transfer: Rec.709 SDR, or Rec.2020 SDR / HLG / PQ. */
  space: z.enum(['rec709', 'rec2020', 'rec2020-hlg', 'rec2020-pq']).default('rec709'),
  range: z.enum(['limited', 'full']).default('limited'),
  bitDepth: z.union([z.literal(8), z.literal(10)]).default(8),
});

/**
 * How a video is placed on an output canvas of another shape (a 16:9 video on a 9:16 canvas):
 * `contain` shows all of it with black bars, `cover` fills the canvas cropping the rest,
 * `stretch` fills it distorting the video, `blur` is `contain` over a blurred `cover` copy.
 */
export const VideoFitModeSchema = z.enum(['contain', 'cover', 'stretch', 'blur']);

/** Clockwise turn of the video in degrees, applied before fitting it (a 16:9 video turned 90° fills a 9:16 canvas). */
export const VideoRotationSchema = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);

export const VideoFitSchema = z.object({
  mode: VideoFitModeSchema.default('contain'),
  rotation: VideoRotationSchema.default(0),
  /**
   * Turn the widgets with the video: they are laid out on the canvas turned back (16:9 for a
   * 16:9 video turned on a 9:16 canvas), so a landscape template works unchanged.
   */
  rotateWidgets: z.boolean().default(false),
  /** Scale over the fitted size (1 = fitted); the overflow is cropped. */
  zoom: z.number().min(1).max(4).default(1),
  /**
   * Where the video sits where it is smaller than the canvas, or the part kept where it is
   * larger: 0 = left / top, 0.5 = centre, 1 = right / bottom.
   */
  x: z.number().min(0).max(1).default(0.5),
  y: z.number().min(0).max(1).default(0.5),
});

/**
 * Encoding properties of the rendered output; its size is the canvas widgets are placed on.
 * Taken from the first video, 1080p60 Rec.709 otherwise.
 */
export const OutputSettingsSchema = z.object({
  width: z.number().int().positive().default(1920),
  height: z.number().int().positive().default(1080),
  frameRate: z.number().positive().default(60),
  color: ColorSettingsSchema.prefault({}),
  /** How the videos are placed on the canvas. */
  fit: VideoFitSchema.prefault({}),
});

export const VideoCodecSchema = z.enum(['h264', 'hevc', 'av1']);

export const EncoderSettingsSchema = z.object({
  /** Preset the values come from ('custom' once edited by hand). */
  preset: z.string().default('youtube-sdr-h264-1080p60'),
  codec: VideoCodecSchema.default('h264'),
  bitrateMbps: z.number().positive().default(12),
  keyframeIntervalSeconds: z.number().positive().default(0.5),
  bFrames: z.number().int().min(0).default(2),
  audio: z.enum(['copy', 'aac', 'none']).default('aac'),
  audioBitrateKbps: z.number().int().positive().default(384),
  /** `auto` decodes and encodes on the GPU when it works, `software` always uses the CPU. */
  acceleration: z.enum(['auto', 'software']).default('auto'),
});

/**
 * Resampling used when the output size differs from the video. Only spatial scalers apply to
 * recorded video (DLSS / XeSS are temporal and need game engine motion vectors).
 */
export const ScalingSchema = z.enum(['bilinear', 'bicubic', 'lanczos', 'fsr1']);

/** Range to export in timeline seconds; null bounds follow the timeline start / end. */
export const RangeSchema = z.object({
  start: z.number().nullable().default(null),
  end: z.number().nullable().default(null),
});

export const ExportSettingsSchema = z.object({
  mode: z.enum(['video', 'image-sequence']).default('video'),
  outputPath: z.string().nullable().default(null),
  imageFormat: z.enum(['png']).default('png'),
  range: RangeSchema.prefault({}),
  /** Last used encoder settings, kept with the project. */
  encoder: EncoderSettingsSchema.prefault({}),
  scaling: ScalingSchema.default('lanczos'),
});

/** Snap lines of the editor, as fractions of the frame: divisions, a safe margin and extra lines. */
export const GuidesSchema = z.object({
  /** Vertical lines splitting the width into this many columns (0 or 1 = none). */
  columns: z.number().int().min(0).max(24).default(0),
  /** Horizontal lines splitting the height into this many rows. */
  rows: z.number().int().min(0).max(24).default(0),
  /** Safe area margin in % of the frame (lines at the margin and 100 − margin). */
  margin: z.number().min(0).max(49).default(0),
  /** Extra vertical lines, % of the width from the left. */
  vertical: z.array(z.number().min(0).max(100)).default([]),
  /** Extra horizontal lines, % of the height from the top. */
  horizontal: z.array(z.number().min(0).max(100)).default([]),
});

/** A reusable collection of widgets ("my car overlay"), independent of any video. */
export const TemplateSchema = z.object({
  version: z.literal(1),
  name: z.string().default('Untitled template'),
  /** Anti-alias widget edges (2x supersampling); widgets can override it. */
  antialias: z.boolean().default(true),
  /** CSS font family used by text in widgets unless a widget sets its own. */
  font: z.string().default("'Segoe UI', 'Helvetica Neue', Arial, sans-serif"),
  /** Value scripts the widgets need, shipped with the template. */
  values: z.array(ValueScriptSchema).default([]),
  widgets: z.array(WidgetSchema).default([]),
  /** When the widgets are drawn (timeline seconds); each widget may set its own range. */
  visibleRange: VisibleRangeSchema.prefault({}),
  /** Snap lines shown while editing (never rendered). */
  guides: GuidesSchema.prefault({}),
});

export const ProjectSchema = z.object({
  version: z.literal(1),
  name: z.string().default('Untitled project'),
  videos: z.array(VideoRefSchema).default([]),
  sources: z.array(SourceRefSchema).default([]),
  output: OutputSettingsSchema.prefault({}),
  palette: PaletteSchema.prefault({}),
  /** Project value scripts; they override template values with the same id. */
  values: z.array(ValueScriptSchema).default([]),
  /** Path of an external template file, so the same template can be reused across projects. */
  templatePath: z.string().nullable().default(null),
  /** Inline template, used when `templatePath` is null. */
  template: TemplateSchema.prefault({ version: 1 }),
  /** Start/finish and sector lines, and where lap values come from. */
  track: TrackSchema.prefault({}),
  /** The part of the session the data comes from (laps, distance... start over inside it). */
  dataRange: DataRangeSchema.prefault({}),
  export: ExportSettingsSchema.prefault({}),
});

export type SourceRef = z.infer<typeof SourceRefSchema>;
export type VideoRef = z.infer<typeof VideoRefSchema>;
export type ColorSettings = z.infer<typeof ColorSettingsSchema>;
export type VideoFitMode = z.infer<typeof VideoFitModeSchema>;
export type VideoRotation = z.infer<typeof VideoRotationSchema>;
export type VideoFit = z.infer<typeof VideoFitSchema>;
export type OutputSettings = z.infer<typeof OutputSettingsSchema>;
export type VideoCodec = z.infer<typeof VideoCodecSchema>;
export type EncoderSettings = z.infer<typeof EncoderSettingsSchema>;
export type Scaling = z.infer<typeof ScalingSchema>;
export type ExportSettings = z.infer<typeof ExportSettingsSchema>;
export type Guides = z.infer<typeof GuidesSchema>;
export type Template = z.infer<typeof TemplateSchema>;
export type Project = z.infer<typeof ProjectSchema>;

export function createProject(overrides: Partial<Project> = {}): Project {
  return ProjectSchema.parse({ version: 1, ...overrides });
}

export function createTemplate(overrides: Partial<Template> = {}): Template {
  return TemplateSchema.parse({ version: 1, ...overrides });
}

export const DEFAULT_OUTPUT: OutputSettings = OutputSettingsSchema.parse({});

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(`${message}:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ValidationError';
  }
}

function parseWith<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  throw new ValidationError(
    `Invalid ${what}`,
    result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  );
}

export function parseProject(data: unknown): Project {
  const project = parseWith(ProjectSchema, data, 'project');
  const { encoder } = project.export;
  // Presets of earlier versions (e.g. `youtube`) become the current preset they map to.
  if (encoder.preset !== 'custom' && !ENCODE_PRESETS.some((p) => p.id === encoder.preset)) {
    project.export.encoder = encoderForPreset(encoder.preset, project.output, encoder.acceleration);
  }
  return project;
}

export function parseTemplate(data: unknown): Template {
  return parseWith(TemplateSchema, data, 'template');
}

export function parseValueCollection(data: unknown): ValueCollection {
  return parseWith(ValueCollectionSchema, data, 'value collection');
}

export function serializeValueCollection(collection: ValueCollection): string {
  return `${JSON.stringify(collection, null, 2)}
`;
}

export function parseWidgetFile(data: unknown): WidgetFile {
  return parseWith(WidgetFileSchema, data, 'widget file');
}

export function serializeWidgetFile(file: WidgetFile): string {
  return `${JSON.stringify(file, null, 2)}
`;
}

export function parseTrackFile(data: unknown): TrackFile {
  return parseWith(TrackFileSchema, data, 'track file');
}

export function serializeTrackFile(file: TrackFile): string {
  return `${JSON.stringify(file, null, 2)}
`;
}

export function serializeProject(project: Project): string {
  return `${JSON.stringify(project, null, 2)}\n`;
}

export function serializeTemplate(template: Template): string {
  return `${JSON.stringify(template, null, 2)}\n`;
}

let idCounter = 0;

/** Short unique id for project entities. */
export function createId(prefix: string): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/** Id of the telemetry source embedded in a video. */
export function embeddedSourceId(videoId: string): string {
  return `${videoId}-telemetry`;
}
