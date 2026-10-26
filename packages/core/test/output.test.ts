import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  defaultOutputFolder,
  defaultOutputPath,
  exportOutputPath,
  numberedPath,
  outputBaseName,
} from '../src/export/output.js';
import { createProject, createTemplate, type Project } from '../src/model/project.js';
import { exportProject } from '../src/node/export.js';
import { addSource, addVideo } from '../src/project-ops.js';
import { evaluateWorkflow } from '../src/workflow/workflow.js';
import { videoInfo } from './helpers/fixtures.js';

const withVideo = (path: string, name = 'Puma at Tarumã') =>
  addVideo(createProject({ name }), { path, info: videoInfo({ path }), hasTelemetry: false }).project;

describe('default export location', () => {
  it('goes next to the first video, named after the project', () => {
    const project = withVideo('C:\\Videos\\GoPro\\GX010082.MP4');
    expect(defaultOutputFolder(project)).toBe('C:\\Videos\\GoPro\\');
    expect(defaultOutputPath(project)).toBe('C:\\Videos\\GoPro\\Puma at Tarumã.mp4');
    const sequence = { ...project, export: { ...project.export, mode: 'image-sequence' as const } };
    expect(defaultOutputPath(sequence)).toBe('C:\\Videos\\GoPro\\Puma at Tarumã frames');
    expect(defaultOutputPath(withVideo('/home/me/race/DJI_0001.MP4', 'Race'))).toBe('/home/me/race/Race.mp4');
  });

  it('uses the first data source without videos, and the chosen path first', () => {
    const { project } = addSource(createProject({ name: 'Laps' }), {
      kind: 'racechrono',
      path: '/logs/session.csv',
    });
    expect(defaultOutputFolder(project)).toBe('/logs/');
    expect(defaultOutputPath(createProject())).toBeNull();
    const chosen = { ...project, export: { ...project.export, outputPath: '/out/mine.mp4' } };
    expect(exportOutputPath(chosen)).toBe('/out/mine.mp4');
  });

  it('makes a file name from the project name', () => {
    expect(outputBaseName({ name: 'Race: 24/10 <final>?' })).toBe('Race 24 10 final');
    expect(outputBaseName({ name: '  ...  ' })).toBe('overlay');
    expect(outputBaseName({ name: 'Puma v1.2.' })).toBe('Puma v1.2');
  });

  it('numbers files and folders', () => {
    expect(numberedPath('C:\\out\\Race.mp4', 2)).toBe('C:\\out\\Race (2).mp4');
    expect(numberedPath('/out/Puma v1.2 frames', 3, false)).toBe('/out/Puma v1.2 frames (3)');
  });

  it('only asks for a location when there is no media to put it next to', () => {
    const noOutput = (project: Project) =>
      evaluateWorkflow({ project })
        .find((s) => s.id === 'export')
        ?.issues.some((i) => i.message === 'Choose an output location');
    expect(noOutput(withVideo('/videos/a.mp4'))).toBe(false);
    expect(noOutput(createProject())).toBe(true);
  });
});

describe('exporting to the default location', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'custom-overlay-output-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('never replaces an earlier export', async () => {
    const { project: base } = addSource(createProject({ name: 'Run' }), {
      kind: 'racechrono',
      path: join(dir, 'log.csv'),
    });
    const project: Project = {
      ...base,
      output: {
        ...base.output,
        width: 64,
        height: 36,
        frameRate: 10,
        color: { space: 'rec709', range: 'limited', bitDepth: 8 },
      },
      template: createTemplate(),
      export: { ...base.export, mode: 'image-sequence', range: { start: 0, end: 0.3 } },
    };
    await mkdir(join(dir, 'Run frames'));
    await writeFile(join(dir, 'Run frames', 'old.png'), '');
    const result = await exportProject({ project, media: { videos: {}, series: {} }, workers: 0 });
    expect(result.outputPath).toBe(join(dir, 'Run frames (2)'));
  }, 30_000);
});
