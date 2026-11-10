// Offline cache (only active over HTTPS or localhost). Network-first so updates
// arrive when online; falls back to the cached copy in the gym.
const CACHE = 'liftlog-v5';
const CORE = ['./', 'index.html', 'app.css', 'manifest.webmanifest', 'icon.svg', 'vendor/sql-wasm.js', 'vendor/sql-wasm.wasm',
  'app/main.js', 'app/ui.js', 'app/store.js', 'app/session.js', 'app/logger.js', 'app/insights.js', 'app/bodymap.js', 'app/status.js', 'app/pad.js', 'app/summary.js', 'app/sheets.js', 'app/browse.js', 'app/plan.js', 'app/settings.js', 'app/library.js'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).pathname.includes('/data/')) return;
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request)));
});
