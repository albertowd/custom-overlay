import { resolve } from 'node:path';
import {
  addSource,
  addVideo,
  autoSyncProject,
  blockingIssues,
  computeTimeline,
  createProject,
  createTemplate,
  evaluateWorkflow,
  type Project,
  parseTimeInput,
  type SourceKind,
  summarizeSeries,
} from '@custom-overlay/core';
import {
  detectSourceKind,
  exportProject,
  loadProjectMedia,
  loadSourceFile,
  loadVideo,
  readProjectFile,
  resolveProjectTemplate,
  writeProjectFile,
  writeTemplateFile,
} from '@custom-overlay/core/node';
import { Command, InvalidArgumentError, Option } from 'commander';
import {
  formatDuration,
  formatOutput,
  formatSeries,
  formatSyncOutcome,
  formatSyncResult,
  formatVideo,
  formatWorkflow,
} from './format.js';
import { registerValuesCommands } from './values.js';

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, (_, v) => (v instanceof Float64Array ? `<${v.length} samples>` : v), 2));
}

function parseKind(value: string): SourceKind {
  if (value === 'racechrono' || value === 'gopro' || value === 'dji') return value;
  throw new InvalidArgumentError('expected "racechrono", "gopro" or "dji"');
}

function parseMinutes(value: string): number {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || Math.abs(minutes) > 14 * 60) {
    throw new InvalidArgumentError('expected minutes east of UTC, e.g. -180 for UTC-3');
  }
  return minutes;
}

const cameraTimezoneOption = () =>
  new Option(
    '--camera-tz <minutes>',
    "camera clock timezone in minutes east of UTC, used without GPS time (default: this machine's)",
  ).argParser(parseMinutes);

function sourceKindOf(path: string): SourceKind {
  const kind = detectSourceKind(path);
  if (!kind) throw new Error(`Cannot detect the type of data source '${path}'`);
  return kind;
}

/** Build a project from files: videos first (the first one is the reference), then sources. */
async function buildProject(
  videos: string[],
  sources: string[],
  base: Project = createProject(),
): Promise<Project> {
  let built = base;
  for (const video of videos) {
    const path = resolve(video);
    const loaded = await loadVideo(path);
    built = addVideo(built, {
      path,
      info: loaded.info,
      hasTelemetry: loaded.telemetry !== null,
      telemetryKind: loaded.telemetry?.kind,
    }).project;
  }
  for (const source of sources) {
    const path = resolve(source);
    built = addSource(built, { kind: sourceKindOf(path), path }).project;
  }
  return built;
}

function isVideoFile(path: string): boolean {
  return /\.(mp4|mov)$/i.test(path);
}

/** The `custom-overlay` command line, ready to parse arguments. */
export function createProgram(): Command {
  const program = new Command()
    .name('custom-overlay')
    .description('Sync GoPro videos with telemetry and render overlay widgets')
    .version('0.1.0');

  program
    .command('probe')
    .description('Show information about a video and its embedded telemetry')
    .argument('<video>', 'video file (GoPro MP4)')
    .option('--json', 'output JSON')
    .action(async (videoPath: string, options: { json?: boolean }) => {
      const video = await loadVideo(resolve(videoPath));
      const telemetry = video.telemetry ? summarizeSeries(video.telemetry) : null;
      if (options.json) return printJson({ info: video.info, telemetry });
      console.log(formatVideo(video.info));
      if (telemetry) console.log(`\n${formatSeries(telemetry)}`);
    });

  program
    .command('source')
    .description('Show the channels of a telemetry data source')
    .argument('<file>', 'data source file (RaceChrono CSV, GoPro MP4)')
    .addOption(new Option('--kind <kind>', 'source type (detected from extension)').argParser(parseKind))
    .option('--json', 'output JSON')
    .action(async (file: string, options: { kind?: SourceKind; json?: boolean }) => {
      const series = await loadSourceFile(resolve(file), options.kind ?? sourceKindOf(file));
      const summary = summarizeSeries(series);
      if (options.json) return printJson({ summary, metadata: series.metadata });
      console.log(formatSeries(summary));
    });

  program
    .command('sync')
    .description('Place videos (MP4) and data sources (CSV) on one timeline; the first file is the reference')
    .argument('<files...>', 'videos and data sources, reference first')
    .addOption(cameraTimezoneOption())
    .option('--json', 'output JSON')
    .action(async (files: string[], options: { json?: boolean; cameraTz?: number }) => {
      const videos = files.filter(isVideoFile);
      const sources = files.filter((f) => !isVideoFile(f));
      const built = await buildProject(videos, sources);
      const media = await loadProjectMedia(built);
      const report = autoSyncProject(built, media, false, { timezoneOffsetMinutes: options.cameraTz });
      if (options.json) return printJson(report.results);
      console.log('timeline time = item time + offset\n');
      for (const outcome of report.results) {
        console.log(outcome.label);
        if (outcome.candidates.length === 0) console.log('  no automatic sync possible');
        for (const candidate of outcome.candidates) console.log(`  ${formatSyncResult(candidate)}`);
      }
    });

  const project = program.command('project').description('Create and inspect project files');

  project
    .command('init')
    .description('Create a project file')
    .argument('<output>', 'project file to create (*.overlay.json)')
    .option('--name <name>', 'project name')
    .option('--video <path...>', 'video files (the first one is the timeline reference)')
    .option('--source <path...>', 'data source files')
    .option('--template <path>', 'external template file')
    .option('--no-auto-sync', 'do not compute source offsets')
    .addOption(cameraTimezoneOption())
    .action(
      async (
        output: string,
        options: {
          name?: string;
          video?: string[];
          source?: string[];
          template?: string;
          autoSync: boolean;
          cameraTz?: number;
        },
      ) => {
        const base = createProject({
          name: options.name ?? 'Untitled project',
          templatePath: options.template ? resolve(options.template) : null,
        });
        let created = await buildProject(options.video ?? [], options.source ?? [], base);
        if (created.videos.length === 0) {
          created = { ...created, export: { ...created.export, mode: 'image-sequence' } };
        }
        if (options.autoSync) {
          const media = await loadProjectMedia(created);
          const report = autoSyncProject(created, media, false, { timezoneOffsetMinutes: options.cameraTz });
          created = report.project;
          for (const outcome of report.results) console.log(formatSyncOutcome(outcome));
        }
        await writeProjectFile(resolve(output), created);
        console.log(`Project written to ${resolve(output)}`);
      },
    );

  project
    .command('status')
    .description('Load the project media and show the workflow status')
    .argument('<file>', 'project file')
    .option('--json', 'output JSON')
    .action(async (file: string, options: { json?: boolean }) => {
      const loaded = await readProjectFile(resolve(file));
      const media = await loadProjectMedia(loaded);
      const statuses = evaluateWorkflow({ project: loaded, failedIds: Object.keys(media.errors) });
      const timeline = computeTimeline(loaded, media);
      if (options.json) return printJson({ statuses, timeline, errors: media.errors });
      console.log(`Project:  ${loaded.name}`);
      console.log(`Output:   ${formatOutput(loaded.output)}`);
      console.log(
        `Timeline: ${formatDuration(timeline.start)} to ${formatDuration(timeline.end)} (${formatDuration(timeline.durationSeconds)})`,
      );
      for (const video of loaded.videos) {
        const info = media.videos[video.id];
        const state = media.errors[video.id]
          ? `error: ${media.errors[video.id]}`
          : `at ${video.offsetSeconds.toFixed(3)} s, ${formatDuration(info?.durationSeconds ?? Number.NaN)}`;
        console.log(`Video:    ${video.label}${video.enabled ? '' : ' (disabled)'} ${state}`);
      }
      for (const source of loaded.sources.filter((s) => s.videoId === null)) {
        const state = media.errors[source.id]
          ? `error: ${media.errors[source.id]}`
          : `offset ${source.offsetSeconds.toFixed(3)} s`;
        console.log(
          `Source:   ${source.label} [${source.kind}${source.enabled ? '' : ', disabled'}] ${state}`,
        );
      }
      console.log(`\n${formatWorkflow(statuses)}`);
    });

  project
    .command('sync')
    .description('Auto sync the videos and sources of a project and save it')
    .argument('<file>', 'project file')
    .option('--force', 'also re-sync sources already synced')
    .addOption(cameraTimezoneOption())
    .action(async (file: string, options: { force?: boolean; cameraTz?: number }) => {
      const path = resolve(file);
      const loaded = await readProjectFile(path);
      const media = await loadProjectMedia(loaded);
      const report = autoSyncProject(loaded, media, options.force, {
        timezoneOffsetMinutes: options.cameraTz,
      });
      if (report.results.length === 0) console.log('Nothing to sync.');
      for (const outcome of report.results) console.log(formatSyncOutcome(outcome));
      await writeProjectFile(path, report.project);
    });

  program
    .command('template')
    .description('Create an empty widget template file')
    .argument('<output>', 'template file to create (*.template.json)')
    .option('--name <name>', 'template name')
    .action(async (output: string, options: { name?: string }) => {
      await writeTemplateFile(resolve(output), createTemplate(options.name ? { name: options.name } : {}));
      console.log(`Template written to ${resolve(output)}`);
    });

  program
    .command('export')
    .description("Render a project's export (video or transparent PNG sequence) with its export settings")
    .argument('<file>', 'project file')
    .option(
      '-o, --output <path>',
      'output file (video) or folder (image sequence); default: the saved one, else next to the videos (or data), named after the project',
    )
    .option('--start <time>', 'range start, e.g. 1:30 or 90.5 (instead of the saved range)')
    .option('--end <time>', 'range end')
    .option('--software', 'decode and encode on the CPU only')
    .option('--threads <n>', 'threads drawing the widgets', (v) => Number.parseInt(v, 10))
    .option('--ffmpeg <path>', 'ffmpeg executable (default: FFMPEG_PATH, then the bundled one)')
    .action(
      async (
        file: string,
        options: {
          output?: string;
          start?: string;
          end?: string;
          software?: boolean;
          threads?: number;
          ffmpeg?: string;
        },
      ) => {
        const loaded = await readProjectFile(resolve(file));
        const media = await loadProjectMedia(loaded);
        const failed = Object.entries(media.errors);
        if (failed.length > 0)
          throw new Error(`Could not load: ${failed.map(([id, e]) => `${id} (${e})`).join(', ')}`);
        const time = (text: string | undefined, fallback: number | null) => {
          if (text === undefined) return fallback;
          const seconds = parseTimeInput(text.includes(':') || text.includes('.') ? text : `${text}.`);
          if (Number.isNaN(seconds)) throw new InvalidArgumentError(`Not a time: ${text}`);
          return seconds;
        };
        const settings = loaded.export;
        const project = {
          ...loaded,
          export: {
            ...settings,
            outputPath: options.output ? resolve(options.output) : settings.outputPath,
            range: {
              start: time(options.start, settings.range.start),
              end: time(options.end, settings.range.end),
            },
            encoder: {
              ...settings.encoder,
              acceleration: options.software ? ('software' as const) : settings.encoder.acceleration,
            },
          },
        };
        const blocking = blockingIssues(evaluateWorkflow({ project }));
        if (blocking.length > 0) throw new Error(`Cannot export:\n  ${blocking.join('\n  ')}`);
        const template = await resolveProjectTemplate(project);
        const interactive = process.stderr.isTTY;
        const result = await exportProject({
          project,
          media,
          template,
          ffmpegPath: options.ffmpeg,
          workers: options.threads,
          onProgress: (p) => {
            const line = `${((p.frame / p.frames) * 100).toFixed(1)}%  frame ${p.frame}/${p.frames}  ${p.fps.toFixed(1)} fps  ${
              Number.isFinite(p.etaSeconds) ? `${formatDuration(p.etaSeconds)} left` : ''
            }`;
            if (interactive) process.stderr.write(`\r${line.padEnd(70)}`);
            else if (p.frame === p.frames || p.frame % 600 === 0) console.error(line);
          },
        });
        if (interactive) process.stderr.write('\n');
        console.log(
          `Exported ${result.frames} frames to ${result.outputPath} in ${formatDuration(result.seconds)}${
            result.encoder ? ` (${result.encoder})` : ''
          }`,
        );
        for (const warning of result.warnings) console.warn(`warning: ${warning}`);
      },
    );

  registerValuesCommands(program, printJson);
  return program;
}
