import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, goproVideo, plainVideo, raceChronoCsv, run, tempDir } from './helpers.js';

let dir: Awaited<ReturnType<typeof tempDir>>;
let video: string;
let csv: string;
const srt = fixture('dji/mini4pro-clip.srt');

beforeAll(async () => {
  dir = await tempDir();
  video = await goproVideo(dir.path);
  csv = await raceChronoCsv(dir.path);
});
afterAll(() => dir.remove());

const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

/** The data sources added from files (not the telemetry embedded in videos). */
interface FileSource {
  kind: string;
  path: string;
  offsetSeconds: number;
  enabled: boolean;
  videoId: string | null;
}
const fileSources = (project: { sources: FileSource[] }): FileSource[] =>
  project.sources.filter((s) => s.videoId === null);

/** The error a command rejects with, and what it printed. */
async function failure(...args: string[]): Promise<Error & { code?: string; output: { stderr: string } }> {
  const error = await run(...args).then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof Error)) throw new Error(`'${args.join(' ')}' did not fail`);
  return error as Error & { code?: string; output: { stderr: string } };
}

describe('probe', () => {
  it('describes the video and its GPMF telemetry', async () => {
    const { stdout } = await run('probe', video);
    expect(stdout).toContain(`File:        ${video}`);
    expect(stdout).toContain('Resolution:  1920x1080 @ 29.97 fps (510 frames)');
    expect(stdout).toContain('Telemetry:   GoPro GPMF track');
    expect(stdout).toContain('Source:      hero7.raw.mp4 (embedded) (gopro)');
    expect(stdout).toMatch(/^latitude\s+Latitude\s+deg\s+308\s/m);
  });

  it('prints JSON with the video info and a telemetry summary', async () => {
    const json = JSON.parse((await run('probe', video, '--json')).stdout);
    expect(json.info).toMatchObject({ width: 1920, height: 1080, hasGpmf: true });
    expect(json.telemetry.kind).toBe('gopro');
    expect(json.telemetry.channels.map((c: { key: string }) => c.key)).toContain('speed');
  });

  it('shows no telemetry section for a video without GPMF', async () => {
    const { stdout } = await run('probe', await plainVideo(dir.path));
    expect(stdout).toContain('Telemetry:   none');
    expect(stdout).not.toContain('Source:');
    expect(
      JSON.parse((await run('probe', join(dir.path, 'plain.mp4'), '--json')).stdout).telemetry,
    ).toBeNull();
  });
});

describe('source', () => {
  it('detects a RaceChrono log and lists its channels', async () => {
    const { stdout } = await run('source', csv);
    expect(stdout).toContain('Source:      Track day (racechrono)');
    expect(stdout).toContain('Start:       2024-05-01T10:00:00.000Z');
    expect(stdout).toMatch(/^speed\s+Speed \(100: gps\)\s+m\/s\s+51\s+10\.0\s+19\s+21$/m);
  });

  it('reads the kind given with --kind and prints JSON with the metadata', async () => {
    const json = JSON.parse((await run('source', srt, '--kind', 'dji', '--json')).stdout);
    expect(json.summary.kind).toBe('dji');
    expect(json.summary.channels.map((c: { key: string }) => c.key)).toContain('relativeAltitude');
    expect(json.metadata).toBeTypeOf('object');
  });

  it('rejects an unknown --kind', async () => {
    const error = await failure('source', srt, '--kind', 'garmin');
    expect(error.code).toBe('commander.invalidArgument');
    expect(error.output.stderr).toContain('expected "racechrono", "gopro" or "dji"');
  });

  it('fails when the kind cannot be detected', async () => {
    const path = join(dir.path, 'notes.txt');
    await writeFile(path, 'hello');
    expect((await failure('source', path)).message).toBe(`Cannot detect the type of data source '${path}'`);
  });
});

describe('sync', () => {
  it('lists the sync candidates of each item against the reference', async () => {
    const lines = (await run('sync', video, csv)).stdout.split('\n');
    expect(lines[0]).toBe('timeline time = item time + offset');
    expect(lines).toContain('session.csv');
    expect(lines.find((l) => l.startsWith('  correlation'))).toMatch(
      /offset 11\.250 s {2}confidence 9\d% {2}- Speed matched with 'hero7\.raw\.mp4'/,
    );
  });

  it('prints the results as JSON', async () => {
    const results = JSON.parse((await run('sync', video, csv, '--camera-tz', '-180', '--json')).stdout);
    expect(results).toHaveLength(1);
    expect(results[0].label).toBe('session.csv');
    expect(results[0].candidates[0]).toMatchObject({ method: 'correlation' });
  });

  it('says when an item cannot be synced automatically', async () => {
    const { stdout } = await run('sync', csv, srt);
    expect(stdout).toContain('mini4pro-clip.srt\n  no automatic sync possible');
  });

  it.each(['1.5', '99999', 'east'])('rejects --camera-tz %s', async (value) => {
    const error = await failure('sync', video, '--camera-tz', value);
    expect(error.code).toBe('commander.invalidArgument');
    expect(error.output.stderr).toContain('expected minutes east of UTC');
  });
});

describe('project', () => {
  it('init creates a synced project from videos and sources', async () => {
    const path = join(dir.path, 'synced.overlay.json');
    const { stdout } = await run(
      'project',
      'init',
      path,
      '--name',
      'Track day',
      '--video',
      video,
      '--source',
      csv,
    );
    expect(stdout).toMatch(/^session\.csv: correlation {2}offset 11\.250 s/m);
    expect(stdout).toContain(`Project written to ${path}`);
    const project = await readJson(path);
    expect(project.name).toBe('Track day');
    expect(project.templatePath).toBeNull();
    expect(project.videos).toHaveLength(1);
    // Paths are saved relative to the project file.
    expect(project.videos[0].path).toBe('hero7.raw.mp4');
    expect(project.sources.find((s: { kind: string }) => s.kind === 'gopro')).toMatchObject({ synced: true });
    const [log] = fileSources(project);
    expect(log).toMatchObject({ kind: 'racechrono', path: 'session.csv' });
    expect(log?.offsetSeconds).toBeCloseTo(11.25, 2);
    expect(project.export.mode).not.toBe('image-sequence');
  });

  it('init with videos only renders a video and has nothing to sync', async () => {
    const path = join(dir.path, 'video-only.overlay.json');
    const { stdout } = await run('project', 'init', path, '--video', await plainVideo(dir.path));
    expect(stdout.trim()).toBe(`Project written to ${path}`);
    const project = await readJson(path);
    expect(project.videos.map((v: { path: string }) => v.path)).toEqual(['plain.mp4']);
    expect(project.sources).toEqual([]);
    expect(project.export.mode).not.toBe('image-sequence');
  });

  it('init without videos exports an image sequence and can skip auto sync', async () => {
    const path = join(dir.path, 'data.overlay.json');
    const template = join(dir.path, 'shared.template.json');
    const { stdout } = await run(
      'project',
      'init',
      path,
      '--source',
      csv,
      srt,
      '--template',
      template,
      '--no-auto-sync',
    );
    expect(stdout.trim()).toBe(`Project written to ${path}`);
    const project = await readJson(path);
    expect(project.name).toBe('Untitled project');
    expect(project.templatePath).toBe('shared.template.json');
    expect(project.videos).toEqual([]);
    expect(fileSources(project).map((s) => s.kind)).toEqual(['racechrono', 'dji']);
    expect(project.export.mode).toBe('image-sequence');
  });

  it('status shows the output, timeline, items and workflow', async () => {
    const path = join(dir.path, 'status.overlay.json');
    await run('project', 'init', path, '--video', video, '--source', csv);
    const lines = (await run('project', 'status', path)).stdout.split('\n');
    expect(lines).toContain('Project:  Untitled project');
    expect(lines).toContain('Output:   1920x1080 @ 29.97 fps, Rec.709, limited range, 8-bit');
    expect(lines).toContain('Timeline: 0:00.000 to 0:17.017 (0:17.017)');
    expect(lines).toContain('Video:    hero7.raw.mp4 at 0.000 s, 0:17.017');
    expect(lines).toContain('Source:   session.csv [racechrono] offset 11.250 s');
    expect(lines).toContain('[x] Videos (complete)');
    expect(lines).toContain('      warn : The template has no widgets yet');
  });

  it('status prints JSON', async () => {
    const path = join(dir.path, 'status.overlay.json');
    const json = JSON.parse((await run('project', 'status', path, '--json')).stdout);
    expect(json.timeline.durationSeconds).toBeCloseTo(17.017, 3);
    expect(json.errors).toEqual({});
    expect(json.statuses.map((s: { title: string }) => s.title)).toContain('Sync');
  });

  it('status marks disabled items and media that failed to load', async () => {
    const path = join(dir.path, 'broken.overlay.json');
    const missingVideo = join(dir.path, 'gone.mp4');
    const missingLog = join(dir.path, 'gone.csv');
    await copyFile(video, missingVideo);
    await copyFile(csv, missingLog);
    await run(
      'project',
      'init',
      path,
      '--video',
      video,
      missingVideo,
      '--source',
      csv,
      missingLog,
      '--no-auto-sync',
    );
    const project = await readJson(path);
    project.videos[0].enabled = false;
    project.sources.find((s: { path: string }) => s.path === 'session.csv').enabled = false;
    await writeFile(path, JSON.stringify(project));
    await Promise.all([writeFile(missingVideo, 'not a video'), writeFile(missingLog, 'not a log')]);

    const lines = (await run('project', 'status', path)).stdout.split('\n');
    // Disabled videos are not loaded, so their duration is unknown.
    expect(lines).toContain('Video:    hero7.raw.mp4 (disabled) at 0.000 s, -');
    expect(lines.find((l) => l.startsWith('Video:    gone.mp4 error: '))).toBeDefined();
    expect(lines).toContain('Source:   session.csv [racechrono, disabled] offset 0.000 s');
    expect(lines.find((l) => l.startsWith('Source:   gone.csv [racechrono] error: '))).toMatch(
      /RaceChrono header/,
    );
    expect(lines).toContain("      error: 'gone.mp4' could not be loaded");
  });

  it('sync re-syncs with --force, then has nothing left to do', async () => {
    const path = join(dir.path, 'resync.overlay.json');
    await run('project', 'init', path, '--video', video, '--source', csv, '--no-auto-sync');
    expect(fileSources(await readJson(path))[0]?.offsetSeconds).toBe(0);

    expect((await run('project', 'sync', path, '--camera-tz', '60')).stdout).toMatch(
      /^session\.csv: correlation/,
    );
    expect(fileSources(await readJson(path))[0]?.offsetSeconds).toBeCloseTo(11.25, 2);
    expect((await run('project', 'sync', path)).stdout.trim()).toBe('Nothing to sync.');
    expect((await run('project', 'sync', path, '--force')).stdout).toMatch(/^session\.csv: correlation/);
  });
});

describe('template', () => {
  it('writes an empty template with the given name', async () => {
    const path = join(dir.path, 'named.template.json');
    expect((await run('template', path, '--name', 'Race HUD')).stdout.trim()).toBe(
      `Template written to ${path}`,
    );
    const template = await readJson(path);
    expect(template.name).toBe('Race HUD');
    expect(template.widgets).toEqual([]);
  });

  it('uses the default template name', async () => {
    const path = join(dir.path, 'default.template.json');
    await run('template', path);
    expect((await readJson(path)).name).toBeTypeOf('string');
  });
});

describe('program', () => {
  it('prints the version', async () => {
    const error = await failure('--version');
    expect(error.code).toBe('commander.version');
    expect((await run('--help').catch((e: { output: { stdout: string } }) => e.output)).stdout).toContain(
      'Usage: custom-overlay',
    );
  });
});
