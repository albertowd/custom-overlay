// jsdom has no layout, canvas or media playback: stub what the renderer uses so components mount.
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { installFakeApi } from './fake-api';
import { FakeResizeObserver } from './resize-observer';

/** Canvas 2D context that accepts every call and property (measureText: 10 px per character). */
function fakeContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const state: Record<string | symbol, unknown> = { canvas, globalAlpha: 1 };
  return new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'measureText') return (text: string) => ({ width: String(text).length * 10 });
      if (key === 'getImageData' || key === 'createImageData') {
        return (_x: number, _y: number, w = 1, h = 1) => ({
          width: w,
          height: h,
          data: new Uint8ClampedArray(w * h * 4),
        });
      }
      if (key === 'createLinearGradient' || key === 'createRadialGradient' || key === 'createPattern') {
        return () => ({ addColorStop: () => undefined });
      }
      return () => undefined;
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
  let ctx = contexts.get(this);
  if (!ctx) {
    ctx = fakeContext(this);
    contexts.set(this, ctx);
  }
  return ctx;
} as unknown as typeof HTMLCanvasElement.prototype.getContext;

globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

// Modal dialogs: model `open` and the close event.
const dialog = HTMLDialogElement.prototype as Partial<HTMLDialogElement>;
dialog.showModal ??= function showModal(this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
dialog.close ??= function close(this: HTMLDialogElement) {
  if (!this.hasAttribute('open')) return;
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
};

// Pointer capture (drags on canvases and range bars).
const element = Element.prototype as Partial<Element>;
element.setPointerCapture ??= () => undefined;
element.releasePointerCapture ??= () => undefined;
element.hasPointerCapture ??= () => false;

beforeEach(() => {
  FakeResizeObserver.instances = [];
  installFakeApi();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockReturnValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockReturnValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
