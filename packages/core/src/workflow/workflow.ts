import { exportOutputPath } from '../export/output.js';
import type { Project } from '../model/project.js';
import { enabledSources, enabledVideos, itemsRequiringSync } from './timeline.js';

export const WORKFLOW_STEPS = [
  'videos',
  'sources',
  'sync',
  'track',
  'template',
  'summary',
  'export',
] as const;
export type StepId = (typeof WORKFLOW_STEPS)[number];

export interface StepDefinition {
  id: StepId;
  title: string;
  description: string;
  optional: boolean;
}

export const STEP_DEFINITIONS: Readonly<Record<StepId, StepDefinition>> = {
  videos: {
    id: 'videos',
    title: 'Videos',
    description:
      'Select the videos to overlay (chapters, several cameras...). Skip to export only the widget images.',
    optional: true,
  },
  sources: {
    id: 'sources',
    title: 'Data sources',
    description: 'Add external telemetry. Optional when a video already embeds telemetry.',
    optional: true,
  },
  sync: {
    id: 'sync',
    title: 'Sync',
    description: 'Place every video and data source on the same timeline.',
    optional: false,
  },
  track: {
    id: 'track',
    title: 'Track',
    description:
      'Optional: draw the start/finish and sector lines to time laps and sectors from GPS, and choose where lap values come from.',
    optional: true,
  },
  template: {
    id: 'template',
    title: 'Template',
    description: 'Place and configure widgets over the video.',
    optional: true,
  },
  summary: {
    id: 'summary',
    title: 'Summary',
    description: 'Review the project before exporting.',
    optional: false,
  },
  export: {
    id: 'export',
    title: 'Export',
    description: 'Render the final video or a transparent image sequence of the widgets.',
    optional: false,
  },
};

export type StepState = 'complete' | 'incomplete' | 'skipped' | 'not-applicable';

export type StepIssueCode =
  | 'notLoaded'
  | 'noSourceForVideos'
  | 'noSourceWithoutVideo'
  | 'notSynced'
  | 'noStartFinish'
  | 'noWidgets'
  | 'videoExportWithoutVideo'
  | 'videoExportElsewhere'
  | 'noOutput';

export interface StepIssue {
  severity: 'error' | 'warning';
  /** Stable id of the issue, so apps can show it in another language. */
  code: StepIssueCode;
  /** Values inserted in the message, e.g. the item label. */
  params: Record<string, string>;
  /** English message. */
  message: string;
}

export interface StepStatus extends StepDefinition {
  state: StepState;
  issues: StepIssue[];
  /** False when an earlier step has blocking errors. */
  reachable: boolean;
}

export interface WorkflowContext {
  project: Project;
  /** Ids of videos and sources that failed to load. */
  failedIds?: readonly string[];
  /**
   * Whether this host renders videos (true by default). The web app does not: a video export is
   * done by the desktop app or the CLI, so it needs no output location here.
   */
  videoExport?: boolean;
}

type Evaluation = Pick<StepStatus, 'state' | 'issues'>;

const error = (code: StepIssueCode, message: string, params: Record<string, string> = {}): StepIssue => ({
  severity: 'error',
  code,
  params,
  message,
});
const warning = (code: StepIssueCode, message: string): StepIssue => ({
  severity: 'warning',
  code,
  params: {},
  message,
});

function evaluateVideos({ project, failedIds = [] }: WorkflowContext): Evaluation {
  const videos = enabledVideos(project);
  if (videos.length === 0) return { state: 'skipped', issues: [] };
  const issues = videos
    .filter((v) => failedIds.includes(v.id))
    .map((v) => error('notLoaded', `'${v.label}' could not be loaded`, { label: v.label }));
  return { state: issues.length > 0 ? 'incomplete' : 'complete', issues };
}

function evaluateSources({ project, failedIds = [] }: WorkflowContext): Evaluation {
  const sources = enabledSources(project);
  const issues: StepIssue[] = [];
  for (const source of sources) {
    if (failedIds.includes(source.id))
      issues.push(error('notLoaded', `'${source.label}' could not be loaded`, { label: source.label }));
  }
  if (sources.length === 0) {
    issues.push(
      project.videos.length > 0
        ? error('noSourceForVideos', 'The videos have no embedded telemetry: add at least one data source')
        : error('noSourceWithoutVideo', 'Without a video, at least one data source is required'),
    );
    return { state: 'incomplete', issues };
  }
  return { state: issues.length > 0 ? 'incomplete' : 'complete', issues };
}

function evaluateSync({ project }: WorkflowContext): Evaluation {
  const pending = itemsRequiringSync(project);
  if (pending.length === 0) return { state: 'not-applicable', issues: [] };
  const unsynced = pending.filter((s) => !s.synced);
  if (unsynced.length === 0) return { state: 'complete', issues: [] };
  return {
    state: 'incomplete',
    issues: unsynced.map((s) => error('notSynced', `'${s.label}' is not synced yet`, { label: s.label })),
  };
}

function evaluateTrack({ project }: WorkflowContext): Evaluation {
  const { startFinish, timing } = project.track;
  if (timing === 'lines' && !startFinish) {
    return {
      state: 'incomplete',
      issues: [
        warning(
          'noStartFinish',
          'Lap values come from the track lines, but there is no start/finish line yet',
        ),
      ],
    };
  }
  return { state: startFinish ? 'complete' : 'skipped', issues: [] };
}

function evaluateTemplate({ project }: WorkflowContext): Evaluation {
  if (project.template.widgets.length === 0 && !project.templatePath) {
    return { state: 'incomplete', issues: [warning('noWidgets', 'The template has no widgets yet')] };
  }
  return { state: 'complete', issues: [] };
}

function evaluateSummary(): Evaluation {
  return { state: 'complete', issues: [] };
}

function evaluateExport({ project, videoExport = true }: WorkflowContext): Evaluation {
  const issues: StepIssue[] = [];
  if (project.export.mode === 'video' && enabledVideos(project).length === 0) {
    issues.push(
      error(
        'videoExportWithoutVideo',
        'Exporting a video requires a source video; choose the image sequence mode',
      ),
    );
  }
  if (project.export.mode === 'video' && !videoExport) {
    issues.push(
      warning(
        'videoExportElsewhere',
        'The final video is exported by the desktop app or the CLI: save the project next to its videos and open it there',
      ),
    );
    return { state: 'incomplete', issues };
  }
  // Without a choice the export goes next to the videos (or data): only media-less projects need one.
  if (!exportOutputPath(project)) issues.push(error('noOutput', 'Choose an output location'));
  return { state: issues.length > 0 ? 'incomplete' : 'complete', issues };
}

const EVALUATORS: Record<StepId, (ctx: WorkflowContext) => Evaluation> = {
  videos: evaluateVideos,
  sources: evaluateSources,
  sync: evaluateSync,
  track: evaluateTrack,
  template: evaluateTemplate,
  summary: evaluateSummary,
  export: evaluateExport,
};

/** Steps that do not need the previous ones: templates can be designed without any data. */
const ALWAYS_REACHABLE: ReadonlySet<StepId> = new Set(['template']);

export function evaluateWorkflow(ctx: WorkflowContext): StepStatus[] {
  let blocked = false;
  return WORKFLOW_STEPS.map((id) => {
    const evaluation = EVALUATORS[id](ctx);
    const reachable = !blocked || ALWAYS_REACHABLE.has(id);
    const status: StepStatus = { ...STEP_DEFINITIONS[id], ...evaluation, reachable };
    if (evaluation.issues.some((i) => i.severity === 'error')) blocked = true;
    return status;
  });
}

/** True when every step before `target` is free of blocking errors. */
export function canEnterStep(statuses: readonly StepStatus[], target: StepId): boolean {
  return statuses.find((s) => s.id === target)?.reachable ?? false;
}

export function nextStep(current: StepId): StepId | null {
  const index = WORKFLOW_STEPS.indexOf(current);
  return WORKFLOW_STEPS[index + 1] ?? null;
}

export function previousStep(current: StepId): StepId | null {
  const index = WORKFLOW_STEPS.indexOf(current);
  return index > 0 ? (WORKFLOW_STEPS[index - 1] ?? null) : null;
}

/** All blocking errors of the workflow, e.g. to refuse an export from the CLI. */
export function blockingIssues(statuses: readonly StepStatus[]): string[] {
  return statuses.flatMap((s) =>
    s.issues.filter((i) => i.severity === 'error').map((i) => `${s.title}: ${i.message}`),
  );
}
