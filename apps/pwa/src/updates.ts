/**
 * New versions of the web app. The service worker installs a new deploy in the background and
 * keeps it waiting while the app is open (see service-worker.js); the app tells the user, who
 * starts it with a reload.
 */

let registration: Promise<ServiceWorkerRegistration | null> = Promise.resolve(null);

/** Register the service worker (the app works offline once built). */
export function registerServiceWorker(): void {
  registration = navigator.serviceWorker.register('./sw.js').catch(() => {
    // Without a service worker the app still works, only not offline.
    return null;
  });
}

/**
 * The new version waiting to start, once it is installed; null when there is none within
 * `timeoutMs` (and on the first visit, when no version runs the page yet).
 */
export async function waitingWorker(timeoutMs = 20_000): Promise<ServiceWorker | null> {
  const reg = await registration;
  if (!reg || !navigator.serviceWorker.controller) return null;
  if (reg.waiting) return reg.waiting;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const done = (worker: ServiceWorker | null) => {
      clearTimeout(timer);
      resolve(worker);
    };
    const watch = (worker: ServiceWorker | null) => {
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed') done(reg.waiting ?? worker);
        else if (worker.state === 'redundant') done(null);
      });
    };
    watch(reg.installing);
    reg.addEventListener('updatefound', () => watch(reg.installing));
    // Asks the server for a newer service worker (the browser also does on each visit).
    reg.update().catch(() => done(null));
  });
}

/** The app version a service worker serves; null when it does not answer (versions before 0.2.2). */
export function versionOf(worker: ServiceWorker, timeoutMs = 2_000): Promise<string | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), timeoutMs);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(typeof event.data === 'string' ? event.data : null);
    };
    worker.postMessage('version', [channel.port2]);
  });
}

/** Start the waiting version: it takes over, and the page reloads into it. */
export async function startWaitingVersion(): Promise<void> {
  const worker = (await registration)?.waiting;
  if (!worker) {
    location.reload();
    return;
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  worker.postMessage('skip-waiting');
}
