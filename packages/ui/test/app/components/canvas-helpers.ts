// Builders and DOM stubs for the canvas components (overlay editor, track map, preview, chart).
import { addVideo, createProject, type Project, type ValueInfo, type VideoInfo } from '@custom-overlay/core';
import { vi } from 'vitest';
import { useStore } from '../../../src/app/store';
import type { ValuesSnapshot } from '../../../src/shared/api';

/** Back to a fresh store (actions included). */
export function resetStore(): void {
  useStore.setState(useStore.getInitialState(), true);
}

export function videoInfo(overrides: Partial<VideoInfo> = {}): VideoInfo {
  return {
    path: '/videos/GX010001.MP4',
    fileName: 'GX010001.MP4',
    sizeBytes: 1_000_000,
    durationSeconds: 10,
    width: 1920,
    height: 1080,
    frameRate: 30,
    frameCount: 300,
    codec: 'avc1',
    creationTime: null,
    hasGpmf: false,
    hasAudio: false,
    color: createProject().output.color,
    camera: { model: null, firmware: null },
    clock: [],
    ...overrides,
  };
}

/** Put a project with one loaded video (served at `media://video`) in the store. */
export function loadVideoProject(info: VideoInfo = videoInfo(), project: Project = createProject()): string {
  const added = addVideo(project, { path: info.path, info, hasTelemetry: false });
  useStore.setState({
    project: added.project,
    videos: { [added.video.id]: info },
    mediaUrls: { [added.video.id]: 'media://video' },
  });
  return added.video.id;
}

export function valueInfo(id: string, unit = 'km/h'): ValueInfo {
  return { id, name: id, description: '', unit, initial: null, origin: 'builtin' };
}

/** Values evaluated on a 30 fps grid: each id gets `count` frames from `fill(frame)`. */
export function valuesSnapshot(
  values: Record<string, (frame: number) => number>,
  count = 300,
  extra: Partial<ValuesSnapshot> = {},
): ValuesSnapshot {
  const data: Record<string, Float64Array> = {};
  for (const [id, fill] of Object.entries(values))
    data[id] = Float64Array.from({ length: count }, (_, i) => fill(i));
  return {
    grid: { start: 0, frameRate: 30, count },
    values: Object.keys(values).map((id) => valueInfo(id)),
    data,
    errors: {},
    full: data,
    ranges: {},
    dataRange: null,
    dataRangeProblems: [],
    ...extra,
  };
}

export interface RecordedCall {
  method: string;
  args: unknown[];
}

/** Canvas contexts that record their calls, installed on every canvas until mocks are restored. */
export function recordCanvases(): {
  calls: RecordedCall[];
  count(method: string): number;
  texts(): string[];
} {
  const calls: RecordedCall[] = [];
  const contexts = new WeakMap<object, CanvasRenderingContext2D>();
  const make = (canvas: object) => {
    const state: Record<string | symbol, unknown> = { canvas, globalAlpha: 1 };
    return new Proxy(state, {
      get(target, key) {
        if (key in target) return target[key];
        if (key === 'measureText') return (text: string) => ({ width: String(text).length * 10 });
        if (key === 'createLinearGradient' || key === 'createRadialGradient' || key === 'createPattern') {
          return () => ({ addColorStop: () => undefined });
        }
        return (...args: unknown[]) => {
          calls.push({ method: String(key), args });
        };
      },
      set(target, key, value) {
        target[key] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    let ctx = contexts.get(this);
    if (!ctx) {
      ctx = make(this);
      contexts.set(this, ctx);
    }
    return ctx;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  return {
    calls,
    count: (method) => calls.filter((c) => c.method === method).length,
    texts: () => calls.filter((c) => c.method === 'fillText').map((c) => String(c.args[0])),
  };
}

/** Give an element a layout box (jsdom reports zeros). */
export function stubRect(element: Element, width: number, height: number, left = 0, top = 0): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect);
}

/** `Image` that loads only when a test says so (jsdom never loads images). */
export class FakeImage {
  static instances: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  complete = false;
  naturalWidth = 0;

  constructor() {
    FakeImage.instances.push(this);
  }

  load(): void {
    this.complete = true;
    this.naturalWidth = 256;
    this.onload?.();
  }

  fail(): void {
    this.onerror?.();
  }
}

/** OffscreenCanvas (anti-aliased widgets draw on scratch canvases): a 2D context accepting anything. */
export class FakeOffscreenCanvas {
  static created = 0;
  constructor(
    public width: number,
    public height: number,
  ) {
    FakeOffscreenCanvas.created++;
  }

  getContext(): CanvasRenderingContext2D {
    return document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
  }
}

/** Points on a circle of `radius` degrees around a centre: a closed GPS lap. */
export function circlePath(
  count: number,
  centre = { latitude: 45, longitude: 7 },
  radius = 0.002,
): { latitude: Float64Array; longitude: Float64Array } {
  const latitude = new Float64Array(count);
  const longitude = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const a = (2 * Math.PI * i) / count;
    latitude[i] = centre.latitude + radius * Math.sin(a);
    longitude[i] = centre.longitude + radius * Math.cos(a);
  }
  return { latitude, longitude };
}
