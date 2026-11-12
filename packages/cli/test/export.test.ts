import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExportOptions, ExportResult } from '@custom-overlay/core/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture, goproVideo, raceChronoCsv, run, tempDir } from './helpers.js';

// Rendering runs ffmpeg: replace it, keep the real project loading around it.
const exportProject = vi.hoisted(() => vi.fn<(options: ExportOptions) => Promise<ExportResult>>());
vi.mock('@custom-overlay/core/node', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@custom-overlay/core/node')>()),
  exportProject,
}));

let dir: Awaited<ReturnType<typeof tempDir>>;
let project: string;

const result = (overrides: Partial<ExportResult> = {}): ExportResult => ({
  outputPath: '/out/Track day.mp4',
  frames: 1200,
  seconds: 65.25,
  encoder: 'libx264',
  workers: 2,
  pipeline: 'cpu',
  warnings: [],
  ...overrides,
});

/** Make the next export report `progress` updates, then resolve with `done`. */
function exportReporting(progress: [frame: number, eta: number][], done: ExportResult): void {
  exportProject.mockImplementationOnce(async (options) => {
    for (const [frame, eta] of progress) {
      options.onProgress?.({ frame, frames: 1200, fps: 48.25, elapsedSeconds: frame / 48, etaSeconds: eta });
    }
    return done;
  });
}

const tty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
const setTty = (value: boolean) =>
  Object.defineProperty(process.stderr, 'isTTY', { value, configurable: true });

beforeAll(async () => {
  dir = await tempDir();
  project = join(dir.path, 'export.overlay.json');
  await run(
    'project',
    'init',
    project,
    '--name',
    'Track day',
    '--video',
    await goproVideo(dir.path),
    '--source',
    await raceChronoCsv(dir.path),
  );
});
afterAll(() => dir.remove());
beforeEach(() => exportProject.mockReset());
afterEach(() => {
  if (tty) Object.defineProperty(process.stderr, 'isTTY', tty);
  else delete (process.stderr as { isTTY?: boolean }).isTTY;
});

describe('export', () => {
  it('renders with the saved settings and logs progress every 600 frames when not a terminal', async () => {
    setTty(false);
    exportReporting(
      [
        [1, Number.NaN],
        [600, 12.5],
        [1200, 0],
      ],
      result({ warnings: ['speed: no data'] }),
    );
    const { stdout, stderr } = await run('export', project);

    expect(exportProject).toHaveBeenCalledOnce();
    const options = exportProject.mock.calls[0]?.[0] as ExportOptions;
    expect(options.project.name).toBe('Track day');
    expect(options.project.export.range).toEqual({ start: null, end: null });
    expect(options.project.export.encoder.acceleration).not.toBe('software');
    expect(options.project.export.disk).toEqual({ slow: false, maxSpeed: 0, stageInTemp: false });
    expect(options.ffmpegPath).toBeUndefined();
    expect(options.workers).toBeUndefined();
    expect(options.pipeline).toBe('auto');
    expect(options.template?.widgets).toEqual([]);
    expect(Object.keys(options.media.videos)).toHaveLength(1);

    expect(stderr.split('\n')).toEqual([
      '50.0%  frame 600/1200  48.3 fps  0:12.500 left',
      '100.0%  frame 1200/1200  48.3 fps  0:00.000 left',
      'warning: speed: no data',
    ]);
    expect(stdout.trim()).toBe(
      'Exported 1200 frames to /out/Track day.mp4 in 1:05.250 (libx264, 2 drawing threads)',
    );
  });

  it('says when the widgets were blended on the GPU, and can keep them on the CPU', async () => {
    setTty(false);
    exportReporting([[1200, 0]], result({ encoder: 'h264_nvenc', pipeline: 'cuda', workers: 7 }));
    const { stdout } = await run('export', project);
    expect(stdout.trim()).toBe(
      'Exported 1200 frames to /out/Track day.mp4 in 1:05.250 (h264_nvenc, widgets blended on the GPU, 7 drawing threads)',
    );
    exportReporting([[1200, 0]], result());
    await run('export', project, '--cpu-blend');
    expect((exportProject.mock.calls[1]?.[0] as ExportOptions | undefined)?.pipeline).toBe('cpu');
  });

  it('applies the command line overrides and redraws progress in a terminal', async () => {
    setTty(true);
    exportReporting([[1, Number.NaN]], result({ encoder: null, outputPath: join(dir.path, 'frames') }));
    const output = join(dir.path, 'frames');
    const { stdout, stderr } = await run(
      'export',
      project,
      '-o',
      output,
      '--start',
      '0:02.5',
      '--end',
      '15',
      '--software',
      '--slow-disk',
      '--max-speed',
      '1.5',
      '--stage-in-temp',
      '--threads',
      '3',
      '--ffmpeg',
      '/opt/ffmpeg',
    );

    const options = exportProject.mock.calls[0]?.[0] as ExportOptions;
    expect(options.project.export.outputPath).toBe(output);
    expect(options.project.export.range).toEqual({ start: 2.5, end: 15 });
    expect(options.project.export.encoder.acceleration).toBe('software');
    expect(options.project.export.disk).toEqual({ slow: true, maxSpeed: 1.5, stageInTemp: true });
    expect(options.workers).toBe(3);
    expect(options.ffmpegPath).toBe('/opt/ffmpeg');

    expect(stderr).toBe(`\r${'0.1%  frame 1/1200  48.3 fps  '.padEnd(70)}\n\n`);
    expect(stdout.trim()).toBe(`Exported 1200 frames to ${output} in 1:05.250`);
  });

  it('tells when the disk slows the export down and when the video is moved', async () => {
    setTty(false);
    exportProject.mockImplementationOnce(async (options) => {
      const progress = { frames: 1200, fps: 48.25, elapsedSeconds: 1, etaSeconds: 0 };
      options.onProgress?.({ ...progress, frame: 600, throttled: true });
      options.onProgress?.({ ...progress, frame: 1200, phase: 'move' });
      return result();
    });
    const { stderr } = await run('export', project);
    expect(stderr.split('\n')).toEqual([
      '50.0%  frame 600/1200  48.3 fps  0:00.000 left  (slowed down for the disk)',
      'moving the video from the temporary folder...',
    ]);
  });

  it('encodes on the chosen brand of graphics card', async () => {
    exportProject.mockResolvedValueOnce(result());
    await run('export', project, '--gpu', 'intel');
    expect(exportProject.mock.calls[0]?.[0].project.export.encoder.acceleration).toBe('intel');
    await expect(run('export', project, '--gpu', 'voodoo')).rejects.toThrow(/voodoo/);
  });

  it('rejects a negative speed limit', async () => {
    await expect(run('export', project, '--max-speed', '-1')).rejects.toThrow(
      '--max-speed must be 0 or more',
    );
    expect(exportProject).not.toHaveBeenCalled();
  });

  it('rejects a range time that is not a time', async () => {
    await expect(run('export', project, '--start', 'lap 2')).rejects.toThrow('Not a time: lap 2');
    expect(exportProject).not.toHaveBeenCalled();
  });

  it('fails when the project media cannot be loaded', async () => {
    const broken = join(dir.path, 'broken.overlay.json');
    const data = JSON.parse(await readFile(project, 'utf8'));
    await writeFile(
      broken,
      JSON.stringify({ ...data, videos: [{ ...data.videos[0], path: 'missing.mp4' }] }),
    );
    await expect(run('export', broken)).rejects.toThrow(/^Could not load: vid-\S+ \(.+\)$/);
    expect(exportProject).not.toHaveBeenCalled();
  });

  it('lists the blocking workflow issues', async () => {
    const unsynced = join(dir.path, 'unsynced.overlay.json');
    await run(
      'project',
      'init',
      unsynced,
      '--source',
      fixture('dji/mini4pro-clip.srt'),
      await raceChronoCsv(dir.path, 'b.csv'),
      '--no-auto-sync',
    );
    await expect(run('export', unsynced)).rejects.toThrow(
      "Cannot export:\n  Sync: 'b.csv' is not synced yet",
    );
    expect(exportProject).not.toHaveBeenCalled();
  });
});
