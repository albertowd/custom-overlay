/** Canvas 2D context that records calls, for rendering tests without a real canvas. */
export interface RecordingContext {
  ctx: CanvasRenderingContext2D;
  calls: { method: string; args: unknown[] }[];
  count(method: string): number;
  texts(): string[];
}

export function recordingContext(): RecordingContext {
  const calls: { method: string; args: unknown[] }[] = [];
  const state: Record<string | symbol, unknown> = { globalAlpha: 1 };
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'measureText') {
        return (text: string) => ({ width: String(text).length * 10 });
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
  return {
    ctx,
    calls,
    count: (method) => calls.filter((c) => c.method === method).length,
    texts: () => calls.filter((c) => c.method === 'fillText').map((c) => String(c.args[0])),
  };
}
