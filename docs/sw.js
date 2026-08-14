/* Greco Time service worker.
 *
 * Sole job: guarantee the app launches with no signal. Entry durability is handled in
 * IndexedDB by app.js, not here — a service worker cannot be relied on to run in the
 * background on iOS, and Safari has no Background Sync API.
 *
 * Bump CACHE whenever the shell changes; the old cache is dropped on activate. */

const CACHE = 'greco-time-v10';

const SHELL = [
  '.',
  'index.html',
  'app.css',
  'names.js',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Individually, so one missing icon cannot fail the whole install.
      .then((c) => Promise.all(SHELL.map((url) => c.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Leave everything else alone: the Apps Script endpoint is a cross-origin POST and
  // must always hit the network, and dev-config.json must never be served stale.
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  if (req.url.includes('dev-config.json')) return;

  // Stale-while-revalidate: instant launch from cache, new version picked up quietly
  // for the next launch.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);

      if (cached) return cached;
      const fresh = await network;
      if (fresh) return fresh;

      // Offline, uncached, and a navigation — fall back to the shell.
      if (req.mode === 'navigate') {
        return (await cache.match('index.html')) || Response.error();
      }
      return Response.error();
    })
  );
});
