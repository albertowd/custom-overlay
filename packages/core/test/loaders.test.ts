import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { detectSourceKind, trackFromData, widgetsFromData } from '../src/io/files.js';
import { MemoryReader } from '../src/io/reader.js';
import { loadSourceFrom, loadVideoFrom, type SourceInput } from '../src/loaders/index.js';
import { createProject, serializeProject } from '../src/model/project.js';
import { getChannel } from '../src/model/telemetry.js';
import { buildMp4 } from './helpers/mp4-builder.js';

const srt = () => readFile(new URL('./fixtures/dji/mini5pro-clip.srt', import.meta.url), 'utf8');

/** A video track without telemetry: 30 one-byte frames at 30 fps. */
const plainVideo = () =>
  buildMp4([
    {
      id: 1,
      handler: 'vide',
      format: 'avc1',
      timescale: 30000,
      sampleDelta: 1000,
      samples: Array.from({ length: 30 }, () => new Uint8Array(1)),
      width: 1280,
      height: 720,
    },
  ]);

function textInput(name: string, text: string): SourceInput {
  return {
    name,
    readText: async () => text,
    withReader: () => Promise.reject(new Error('not a video')),
    findSubtitles: async () => null,
  };
}

describe('file helpers without a file system', () => {
  it('detects the source kind from any path style', () => {
    expect(detectSourceKind('C:\\videos\\GX010001.MP4')).toBe('gopro');
    expect(detectSourceKind('../logs/session.CSV')).toBe('racechrono');
    expect(detectSourceKind('DJI_0001.srt')).toBe('dji');
    expect(detectSourceKind('notes.txt')).toBeNull();
    expect(detectSourceKind('folder.mp4/readme')).toBeNull();
  });

  it('reads track lines from a track file or a project', () => {
    const project = createProject({ name: 'Session' });
    const fromProject = trackFromData(JSON.parse(serializeProject(project)));
    expect(fromProject).toEqual(project.track);
    expect(trackFromData({ version: 1, track: project.track })).toEqual(project.track);
  });

  it('reads widgets from a template', () => {
    const project = createProject({ name: 'Session' });
    expect(widgetsFromData(project.template)).toEqual(project.template.widgets);
  });
});

describe('loading from a reader', () => {
  it('reads a video and the DJI subtitles found next to it', async () => {
    const text = await srt();
    const video = await loadVideoFrom(new MemoryReader(plainVideo()), 'DJI_0001.MP4', async () => ({
      name: 'DJI_0001.SRT',
      text,
    }));
    expect(video.info.fileName).toBe('DJI_0001.MP4');
    expect(video.info.width).toBe(1280);
    expect(video.telemetry?.kind).toBe('dji');
    expect(getChannel(video.telemetry!, 'latitude')).toBeDefined();
  });

  it('has no telemetry without GPMF nor subtitles', async () => {
    const video = await loadVideoFrom(new MemoryReader(plainVideo()), 'clip.mp4', async () => null);
    expect(video.telemetry).toBeNull();
  });

  it('reads text sources and rejects unsupported ones', async () => {
    const series = await loadSourceFrom(textInput('clip.srt', await srt()), 'dji');
    expect(series.name).toBe('clip.srt');
    await expect(loadSourceFrom(textInput('notes.txt', ''), null)).rejects.toThrow(
      "Unsupported data source: 'notes.txt'",
    );
  });

  it('explains when a video used as a source has no telemetry', async () => {
    const input: SourceInput = {
      ...textInput('clip.mp4', ''),
      withReader: (read) => read(new MemoryReader(plainVideo())),
    };
    await expect(loadSourceFrom(input, 'gopro')).rejects.toThrow("'clip.mp4' has no telemetry");
  });
});
