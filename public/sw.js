// public/sw.js
// Caches the app shell (scan.html, index.html, this file) so the page
// itself opens even with zero signal - important for drivers/warehouse
// staff working somewhere without reception. API requests are always
// left to the network (or to fail, which the page's own offline queue in
// offline-queue.js handles) - this worker never caches or fakes API data,
// since keg status must reflect reality, not a stale cached snapshot.

const CACHE_NAME = 'keg-tracker-shell-v3'; // bumped: manifest.json + icons added, for PWA installability
const SHELL_FILES = [
  '/scan.html', '/index.html', '/offline-queue.js', '/device-id.js',
  '/manifest.json', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept API calls - those need real, current data. Offline
  // handling for those lives in offline-queue.js at the page level, where
  // it can make an informed decision (queue vs show cached keg vs error).
  if (url.pathname.startsWith('/api/')) return;

  if (event.request.method !== 'GET') return;

  // Cache-first for the app shell itself, falling back to network, and
  // updating the cache with whatever the network returns.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => cached); // offline: fall back to whatever's cached
      return cached || networkFetch;
    })
  );
});
