import { createProject, type Project } from '@custom-overlay/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addFile } from '../../src/files';
import { environmentIssues, supportIssues } from '../../src/support';

/** What the fake browser can decode and encode, by codec. */
const can = { decode: new Set<string>(), encode: new Set<string>() };
/** Tracks of the fake files, by file name. */
const tracks: Record<string, { video?: string; audio?: string }> = {};

vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  BlobSource: class {
    constructor(readonly file: File) {}
  },
  Input: class {
    private readonly name: string;
    constructor(options: { source: { file: File } }) {
      this.name = options.source.file.name;
    }
    private track(kind: 'video' | 'audio') {
      const codec = tracks[this.name]?.[kind];
      if (codec === 'broken') throw new Error('unreadable');
      return codec ? { codec, canDecode: async () => can.decode.has(codec) } : null;
    }
    getPrimaryVideoTrack = async () => this.track('video');
    getPrimaryAudioTrack = async () => this.track('audio');
    dispose() {}
  },
  canEncodeVideo: vi.fn(
    async (codec: string, options: { width: number }) => can.encode.has(codec) && options.width <= 3840,
  ),
  canEncodeAudio: vi.fn(async (codec: string) => can.encode.has(codec)),
}));

function stubBrowser(options: {
  secure?: boolean;
  webCodecs?: boolean;
  storage?: boolean;
  savePicker?: boolean;
}) {
  vi.stubGlobal('isSecureContext', options.secure ?? true);
  vi.stubGlobal('VideoEncoder', options.webCodecs === false ? undefined : class {});
  vi.stubGlobal('VideoDecoder', options.webCodecs === false ? undefined : class {});
  vi.stubGlobal('navigator', {
    ...navigator,
    storage: options.storage === false ? {} : { getDirectory: async () => ({}) },
  });
  if (options.savePicker) window.showSaveFilePicker = vi.fn() as never;
  else delete window.showSaveFilePicker;
}

let counter = 0;
/** A project with videos of these codecs, picked in this tab (new file names every time). */
function withVideos(...codecs: { video?: string; audio?: string }[]): Project {
  const project = createProject({ name: 'Race' });
  project.videos = codecs.map((codec, i) => {
    const name = `clip-${++counter}.mp4`;
    tracks[name] = codec;
    addFile(new File([], name));
    return { id: `v${i}`, path: name, label: `Clip ${i + 1}`, enabled: true, offsetSeconds: 0, synced: true };
  });
  return project;
}

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

beforeEach(() => {
  can.decode = new Set(['avc', 'hevc', 'aac']);
  can.encode = new Set(['avc', 'hevc', 'aac', 'opus']);
  stubBrowser({ savePicker: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.showSaveFilePicker;
});

describe('the browser', () => {
  it('needs HTTPS before anything else', () => {
    stubBrowser({ secure: false, webCodecs: false });
    expect(environmentIssues()).toEqual([{ code: 'insecureContext', severity: 'error' }]);
  });

  it('needs WebCodecs and private storage, and tells when the video is downloaded', () => {
    expect(environmentIssues()).toEqual([]);
    stubBrowser({ webCodecs: false });
    expect(environmentIssues()).toEqual([{ code: 'noWebCodecs', severity: 'error' }]);
    stubBrowser({ storage: false, savePicker: true });
    expect(codes(environmentIssues())).toEqual(['noPrivateStorage']);
    stubBrowser({});
    expect(environmentIssues()).toEqual([{ code: 'noSavePicker', severity: 'info' }]);
  });
});

describe('the project', () => {
  it('has nothing to say about a project the browser handles', async () => {
    expect(await supportIssues(withVideos({ video: 'avc', audio: 'aac' }))).toEqual([]);
    expect(await supportIssues()).toEqual([]);
  });

  it('flags the videos and sounds this browser cannot decode', async () => {
    can.decode = new Set(['avc']);
    const project = withVideos(
      { video: 'hevc', audio: 'aac' },
      { video: 'avc', audio: 'mp3' },
      { video: 'broken' },
    );
    expect(await supportIssues(project)).toEqual([
      { code: 'cannotDecode', severity: 'error', params: { label: 'Clip 1', codec: 'HEVC (H.265)' } },
      { code: 'cannotDecodeAudio', severity: 'warning', params: { label: 'Clip 2', codec: 'MP3' } },
    ]);
    // Without sound in the export, the sound does not matter.
    project.export.encoder.audio = 'none';
    expect(codes(await supportIssues(project))).toEqual(['cannotDecode']);
    // Videos not picked in this tab, or disabled, are not checked.
    project.videos.push({
      id: 'x',
      path: 'elsewhere.mp4',
      label: 'X',
      enabled: true,
      offsetSeconds: 0,
      synced: true,
    });
    project.videos[0] = { ...(project.videos[0] as Project['videos'][number]), enabled: false };
    expect(await supportIssues(project)).toEqual([]);
  });

  it('flags the output this browser cannot encode, for a video export', async () => {
    const project = withVideos({ video: 'avc' });
    project.export.encoder = { ...project.export.encoder, codec: 'av1' };
    expect(await supportIssues(project)).toEqual([
      { code: 'cannotEncodeVideo', severity: 'warning', params: { codec: 'AV1', size: '1920 × 1080' } },
    ]);
    project.output = {
      ...project.output,
      width: 7680,
      height: 4320,
      color: { ...project.output.color, bitDepth: 10 },
    };
    expect(codes(await supportIssues(project))).toEqual(['cannotEncodeAny', 'eightBitOnly']);
    // Checks are remembered per setting (a browser keeps its codecs): other bitrates ask again.
    can.encode = new Set(['avc', 'opus']);
    project.export.encoder.audioBitrateKbps = 200;
    project.export.encoder.bitrateMbps = 9;
    project.output = {
      ...project.output,
      width: 1920,
      height: 1080,
      color: { ...project.output.color, bitDepth: 8 },
    };
    expect(codes(await supportIssues(project))).toEqual(['cannotEncodeVideo', 'cannotEncodeAac']);
    can.encode = new Set(['avc']);
    project.export.encoder.audioBitrateKbps = 128;
    expect(codes(await supportIssues(project))).toContain('cannotEncodeAudio');
    // An image sequence encodes nothing.
    project.export.mode = 'image-sequence';
    expect(await supportIssues(project)).toEqual([]);
  });

  it('stops at the browser when it cannot export videos', async () => {
    stubBrowser({ webCodecs: false });
    can.decode = new Set();
    expect(codes(await supportIssues(withVideos({ video: 'hevc' })))).toEqual(['noWebCodecs']);
  });
});
