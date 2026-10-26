// gopro-telemetry yields to the event loop thousands of times while parsing, with setImmediate when
// it exists, else setTimeout, which browsers clamp to 4 ms once nested: a 20-minute recording took
// 60 s instead of 4. A MessageChannel yields without the clamp. It must be installed before
// gopro-telemetry loads (it picks its function then): import this module first.

type Immediate = (callback: () => void) => void;
const scope = globalThis as { setImmediate?: Immediate };

if (!scope.setImmediate) {
  const channel = new MessageChannel();
  const queue: (() => void)[] = [];
  channel.port1.onmessage = () => queue.shift()?.();
  scope.setImmediate = (callback) => {
    queue.push(callback);
    channel.port2.postMessage(null);
  };
}

// A module (not a script), so it is imported and evaluated once.
export {};
