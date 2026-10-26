// Service worker of the web app, completed by the build (see vite.config.ts): it fills in the
// version (a hash of the build) and the list of files to precache.
//
// The app shell is precached so the app opens offline. A new version installs in the background
// and takes over once every tab of the app is closed: a page never runs code of two versions,
// and a project being edited is never reloaded under the user.

const VERSION = __VERSION__;
const PRECACHE = __PRECACHE__;
const PREFIX = 'custom-overlay-';
const CACHE = `${PREFIX}${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))),
      ),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Only the app's own files: the track list and map tiles always go to the network.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      // Any page of the app is the app shell.
      const cached = await cache.match(request.mode === 'navigate' ? './' : request);
      return cached ?? fetch(request);
    }),
  );
});
