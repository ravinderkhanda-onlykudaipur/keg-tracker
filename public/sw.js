// public/sw.js
// Caches the app shell (scan.html, index.html, this file) so the page
// itself opens even with zero signal - important for drivers/warehouse
// staff working somewhere without reception. API requests are always
// left to the network (or to fail, which the page's own offline queue in
// offline-queue.js handles) - this worker never caches or fakes API data,
// since keg status must reflect reality, not a stale cached snapshot.

const CACHE_NAME = 'keg-tracker-shell-v15'; // bumped: Holding card now shows the role (Washer/Mover/Filler/Driver/Customer/Warehouse) instead of the holding person's name, and pendingBannerWrap now uses the same 38-phase situation labels already built for the Admin Kegs table / Excel export, ported into scan.html for the first time.
const SHELL_FILES = [
  '/scan.html', '/index.html', '/offline-queue.js', '/device-id.js',
  '/manifest.json', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png',
];
// The in-app QR scanner's library - cached separately (not in SHELL_FILES)
// since cache.addAll() is all-or-nothing: if this external CDN happened
// to be unreachable during install, it would otherwise fail caching the
// entire app shell, not just the scanner. Best-effort here instead - the
// scanner works offline once this has been fetched successfully once;
// until then it just needs a connection the first time it's opened.
const JSQR_CDN_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(SHELL_FILES); // core shell - must succeed for the install to count as successful
      try {
        await cache.add(JSQR_CDN_URL);
      } catch (err) {
        // Not fatal - see comment above. The rest of the app still works.
      }
    })
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

  // Network-first for the app shell: always fetch the latest version
  // when online. This app is still under frequent active development -
  // a cache-first strategy meant a real server-side update could
  // silently fail to reach a user's browser for many rounds (see the
  // CACHE_NAME comment above for the exact incident this caused: Fill
  // Details for Admin/Manager and the Keg ID click fix were both
  // correct in the deployed source, but kept getting served from a
  // stale cache regardless). Falls back to the cached copy only when
  // the network request fails entirely, which is what actually matters
  // for the original offline-support goal - being able to open the
  // app with zero signal, not preferring a cached copy while online.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
