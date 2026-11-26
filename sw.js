/* =========================================================================
   Rails POS service worker — cache-first app shell.

   Every file the app needs is precached on install, so the app opens with
   no internet. Files are always answered from the cache.

   Releasing an update: change CACHE_VERSION below (any change to this file
   counts). Phones download the new version in the background; the app then
   shows "A new version is ready — Reload now". Nothing changes mid-sale.

   Data (products, sales) is NOT here — it lives in IndexedDB.
   PLUG-IN: cloud sync — use a 'sync' event (Background Sync) here to push
   the outbox when the connection comes back.
   ========================================================================= */

const CACHE_VERSION = 'rails-pos-v51';
const APP_SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './fonts/inter-latin.woff2',
  './fonts/playfair-display-latin.woff2',
  // Profit checker add-on (opens inside Reports; copied from Rails Profit checker by tools/copy-profit-checker.sh)
  './profit/index.html',
  './profit/styles.css',
  './profit/app.js',
  './profit/calculations.js',
  './profit/importers.js',
  './profit/till-insights.js',
  './profit/icons/icon.svg',
];

self.addEventListener('install', event => {
  // cache: 'reload' skips the browser's HTTP cache so we store the newest files.
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(APP_SHELL.map(url => new Request(url, { cache: 'reload' }))))
  );
  // No skipWaiting() here: the new version waits until the user taps "Reload now".
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // e.g. wa.me links — let the browser handle them
  if (url.pathname.endsWith('/tests.html')) return; // the test page always comes from the network
  if (/\/(admin\.(html|js|css)|legal\.html)$/.test(url.pathname)) return; // supplier admin and terms page: never cached, always fresh

  event.respondWith((async () => {
    // The test run (index.html?test inside tests.html) always uses the newest files.
    const client = event.clientId ? await self.clients.get(event.clientId) : null;
    if (url.searchParams.has('test') || (client && new URL(client.url).searchParams.has('test'))) {
      return fetch(req, { cache: 'no-store' });
    }
    const cache = await caches.open(CACHE_VERSION);
    // Page navigations get the cached app shell (works offline).
    const key = req.mode === 'navigate' ? (url.pathname.includes('/profit/') ? './profit/index.html' : './index.html') : req;
    const cached = await cache.match(key, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch {
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});
