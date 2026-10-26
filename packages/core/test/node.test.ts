import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject, createTemplate } from '../src/model/project.js';
import {
  detectSourceKind,
  loadSourceFile,
  loadVideo,
  NodeFileReader,
  readProjectFile,
  readTemplateFile,
  resolveProjectTemplate,
  writeProjectFile,
  writeTemplateFile,
} from '../src/node/index.js';
import { addSource, addVideo } from '../src/project-ops.js';
import { videoInfo } from './helpers/fixtures.js';
import { buildMp4 } from './helpers/mp4-builder.js';

let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'custom-overlay-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('node file layer', () => {
  it('reads files at random offsets', async () => {
    const path = join(dir, 'bytes.bin');
    await writeFile(path, new Uint8Array([0, 1, 2, 3, 4, 5]));
    const reader = await NodeFileReader.open(path);
    expect(reader.size).toBe(6);
    expect(Array.from(await reader.read(2, 3))).toEqual([2, 3, 4]);
    expect(Array.from(await reader.read(4, 10))).toEqual([4, 5]);
    await reader.close();
  });

  it('loads a video without telemetry', async () => {
    const path = join(dir, 'clip.mp4');
    await writeFile(
      path,
      buildMp4([
        {
          id: 1,
          handler: 'vide',
          format: 'avc1',
          timescale: 30,
          sampleDelta: 1,
          samples: [new Uint8Array(4)],
          width: 1280,
          height: 720,
        },
      ]),
    );
    const video = await loadVideo(path);
    expect(video.info).toMatchObject({ fileName: 'clip.mp4', width: 1280, hasGpmf: false });
    expect(video.telemetry).toBeNull();
  });

  it('detects and loads sources', async () => {
    expect(detectSourceKind('a/b/LOG.CSV')).toBe('racechrono');
    expect(detectSourceKind('GX010001.MP4')).toBe('gopro');
    expect(detectSourceKind('notes.txt')).toBeNull();
    const csv = join(dir, 'log.csv');
    await writeFile(csv, 'Timestamp,Speed\nunix time,m/s\n1714557600.0,1\n1714557600.1,2\n');
    const series = await loadSourceFile(csv);
    expect(series.channels.map((c) => c.key)).toEqual(['speed']);
    await expect(loadSourceFile(join(dir, 'x.txt'))).rejects.toThrow(/Unsupported/);
  });

  it('stores project paths relative to the project file', async () => {
    let { project } = addVideo(createProject({ name: 'P' }), {
      path: join(dir, 'media', 'GX01.MP4'),
      info: videoInfo(),
      hasTelemetry: true,
    });
    project = addSource(project, { kind: 'racechrono', path: join(dir, 'media', 'log.csv') }).project;
    const projectPath = join(dir, `p.overlay.json`);
    await writeProjectFile(projectPath, project);

    const stored = JSON.parse(await readFile(projectPath, 'utf8'));
    expect(stored.videos[0].path).toBe('media/GX01.MP4');
    expect(stored.sources[1].path).toBe('media/log.csv');

    const loaded = await readProjectFile(projectPath);
    expect(loaded).toEqual(project);
  });

  it('reads external templates', async () => {
    const templatePath = join(dir, 'laps.template.json');
    await writeTemplateFile(templatePath, createTemplate({ name: 'Laps' }));
    expect((await readTemplateFile(templatePath)).name).toBe('Laps');
    const project = createProject({ templatePath });
    expect((await resolveProjectTemplate(project)).name).toBe('Laps');
    expect((await resolveProjectTemplate(createProject())).name).toBe('Untitled template');
  });
});
