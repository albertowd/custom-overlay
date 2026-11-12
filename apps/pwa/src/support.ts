import { enabledVideos, type Project } from '@custom-overlay/core';
import type { SupportIssue } from '@custom-overlay/ui/api';
import { canPickSaveFile, fileAt } from './files';
import { BROWSER_CODECS } from './video-compose';

/**
 * What this browser and device cannot do for the video export, asked to the browser itself
 * (WebCodecs' own support checks), so it holds for its codecs and hardware, whatever its name.
 */

/** Names of codecs as people know them. */
const CODEC_NAMES: Record<string, string> = {
  avc: 'H.264',
  hevc: 'HEVC (H.265)',
  av1: 'AV1',
  vp9: 'VP9',
  vp8: 'VP8',
  aac: 'AAC',
  opus: 'Opus',
  mp3: 'MP3',
};
const codecName = (codec: string | null | undefined) => (codec ? (CODEC_NAMES[codec] ?? codec) : '?');

/** The browser itself: what keeps it from exporting the final video, or changes how. */
export function environmentIssues(): SupportIssue[] {
  if (!window.isSecureContext) return [{ code: 'insecureContext', severity: 'error' }];
  const issues: SupportIssue[] = [];
  if (typeof VideoEncoder !== 'function' || typeof VideoDecoder !== 'function') {
    issues.push({ code: 'noWebCodecs', severity: 'error' });
  } else if (typeof navigator.storage?.getDirectory !== 'function') {
    issues.push({ code: 'noPrivateStorage', severity: 'error' });
  } else if (!canPickSaveFile()) {
    issues.push({ code: 'noSavePicker', severity: 'info' });
  }
  return issues;
}

/** Whether the environment lets this browser export videos at all. */
const exportsVideo = (issues: readonly SupportIssue[]) => !issues.some((i) => i.severity === 'error');

/** Decoding checks by file: a file is checked once. */
const decodeChecks = new WeakMap<File, Promise<{ video: string | null; audio: string | null }>>();

/** Codecs of a file this browser cannot decode (null when it can, or has no such track). */
function checkDecoding(file: File): Promise<{ video: string | null; audio: string | null }> {
  let check = decodeChecks.get(file);
  if (!check) {
    check = (async () => {
      const { ALL_FORMATS, BlobSource, Input } = await import('mediabunny');
      const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
      try {
        const video = await input.getPrimaryVideoTrack();
        const audio = await input.getPrimaryAudioTrack();
        return {
          video: video && !(await video.canDecode()) ? codecName(video.codec) : null,
          audio: audio && !(await audio.canDecode()) ? codecName(audio.codec) : null,
        };
      } catch {
        // Unreadable here: the export says why when it gets there.
        return { video: null, audio: null };
      } finally {
        input.dispose();
      }
    })();
    decodeChecks.set(file, check);
  }
  return check;
}

/** Encoding checks by codec, size and bitrate. */
const encodeChecks = new Map<string, Promise<boolean>>();

async function canEncode(
  kind: 'video' | 'audio',
  codec: string,
  options: Record<string, number>,
): Promise<boolean> {
  const key = `${kind}:${codec}:${JSON.stringify(options)}`;
  let check = encodeChecks.get(key);
  if (!check) {
    check = import('mediabunny').then((m) =>
      kind === 'video'
        ? m.canEncodeVideo(codec as never, options)
        : m.canEncodeAudio(codec as never, { ...options, numberOfChannels: 2, sampleRate: 48_000 }),
    );
    encodeChecks.set(key, check);
  }
  return check;
}

/** The browser, then the project's videos and output settings (for a video export). */
export async function supportIssues(project?: Project): Promise<SupportIssue[]> {
  const issues = environmentIssues();
  if (!project || !exportsVideo(issues)) return issues;
  // Every enabled video, whichever is in the range: they are all on the timeline.
  for (const video of enabledVideos(project)) {
    let file: File;
    try {
      file = fileAt(video.path);
    } catch {
      continue;
    }
    const cannot = await checkDecoding(file);
    if (cannot.video) {
      issues.push({
        code: 'cannotDecode',
        severity: 'error',
        params: { label: video.label, codec: cannot.video },
      });
    } else if (cannot.audio && project.export.encoder.audio !== 'none') {
      issues.push({
        code: 'cannotDecodeAudio',
        severity: 'warning',
        params: { label: video.label, codec: cannot.audio },
      });
    }
  }
  if (project.export.mode !== 'video') return issues;
  const { width, height, color } = project.output;
  const { encoder } = project.export;
  const size = `${width} × ${height}`;
  const options = { width, height, bitrate: encoder.bitrateMbps * 1e6 };
  const wanted = BROWSER_CODECS[encoder.codec];
  if (!(await canEncode('video', wanted, options))) {
    if (wanted !== 'avc' && (await canEncode('video', 'avc', options))) {
      issues.push({
        code: 'cannotEncodeVideo',
        severity: 'warning',
        params: { codec: codecName(wanted), size },
      });
    } else {
      issues.push({ code: 'cannotEncodeAny', severity: 'error', params: { size } });
    }
  }
  if (encoder.audio !== 'none') {
    const audio = { bitrate: encoder.audioBitrateKbps * 1000 };
    if (!(await canEncode('audio', 'aac', audio))) {
      issues.push(
        (await canEncode('audio', 'opus', audio))
          ? { code: 'cannotEncodeAac', severity: 'warning' }
          : { code: 'cannotEncodeAudio', severity: 'warning' },
      );
    }
  }
  if (color.bitDepth === 10 || color.space !== 'rec709')
    issues.push({ code: 'eightBitOnly', severity: 'info' });
  return issues;
}
