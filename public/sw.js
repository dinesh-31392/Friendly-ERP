/**
 * Friendly CRM — service worker.
 *
 * This app is unusual: vite-plugin-singlefile inlines ALL JS and CSS into one
 * self-contained index.html (~1.2MB, ~320KB gzipped). So "the app shell" is
 * literally one document — caching index.html caches the entire application,
 * and there is no asset graph to precache.
 *
 * STRATEGY — navigation: network-first with a short timeout, falling back to
 * cache. The tempting alternative (cache-first / stale-while-revalidate) opens
 * marginally faster but serves a STALE BUILD for at least one session. For a
 * CRM that is a bad trade: a user acting on a superseded version of the app is
 * a real support problem, and "why is my browser showing the old version" is
 * the classic PWA failure mode. Network-first means online users are ALWAYS on
 * the current build, offline users still get the app, and slow connections fall
 * back after TIMEOUT_MS rather than hanging.
 *
 * Data is not touched here: the CRM's dataset lives in localStorage, which is
 * available offline anyway and must never be cached by a service worker.
 */

// Bump to force every client onto a fresh cache. Old caches are deleted on
// activate, so this is the kill switch if a bad build is ever cached.
const CACHE = 'friendly-crm-v1';
const TIMEOUT_MS = 3000;

// Cached up-front so a cold, offline first-launch still works.
const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-192-maskable.png',
  '/icons/icon-512-maskable.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
];

/**
 * Cache one URL, but ONLY if the server really returned that asset.
 *
 * This deliberately avoids cache.add(). The SPA fallback (nginx
 * `try_files $uri $uri/ /index.html`, and Vite's dev server) answers any
 * missing asset with **200 + text/html**, so cache.add('/icons/icon-192.png')
 * on a typo'd or not-yet-built path silently stores the HTML document under the
 * icon's URL — and then serves that HTML as the icon forever, until the cache
 * version is bumped. Observed exactly that during development. Checking the
 * content-type is what makes the precache trustworthy.
 */
async function precacheOne(cache, url) {
  try {
    const res = await fetch(url, { cache: 'reload' });
    if (!res.ok) return;
    const isDocument = url === '/';
    const contentType = res.headers.get('content-type') || '';
    if (!isDocument && contentType.includes('text/html')) return;  // SPA fallback, not the asset
    await cache.put(url, res);
  } catch {
    // Offline during install: skip. The runtime handler will cache it later.
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Individually, so one bad URL cannot fail the whole install and leave
      // the app permanently un-cached.
      .then((cache) => Promise.all(PRECACHE.map((url) => precacheOne(cache, url))))
      // Activate immediately rather than waiting for every tab to close —
      // paired with clients.claim() below this is what stops users being
      // stranded on an old worker.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Network, but don't hang forever on a dead/slow link. */
function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(request).then(
      (res) => { clearTimeout(timer); resolve(res); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only GET is cacheable. Never intercept POST/PUT/DELETE.
  if (request.method !== 'GET') return;
  // Cross-origin (CDNs, tel:, wa.me links) — leave to the browser.
  if (url.origin !== self.location.origin) return;
  // API mode: never cache. Serving a stale lead list would be worse than an
  // honest network error.
  if (url.pathname.startsWith('/api/')) return;
  // Never intercept the worker itself.
  if (url.pathname === '/sw.js') return;

  // SPA navigations (/, /leads, /platform, /site/:slug/:id …). React Router
  // handles the path client-side, so every navigation resolves to index.html.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetchWithTimeout(request, TIMEOUT_MS)
        .then((response) => {
          // Cache under '/' — the SPA fallback means every route returns the
          // same document, so one entry serves them all.
          const copy = response.clone();
          caches.open(CACHE).then((c) => c.put('/', copy));
          return response;
        })
        .catch(async () => {
          // Offline / timed out: any cached route falls back to the app shell.
          const cached = await caches.match('/', { ignoreSearch: true });
          return cached || new Response(
            '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
            '<body style="font:16px system-ui;padding:2rem;color:#3f3f46">' +
            '<h1>You are offline</h1><p>Open Friendly CRM once while connected, ' +
            'then it will work offline.</p>',
            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
          );
        }),
    );
    return;
  }

  // Static same-origin assets (icons, manifest): cache-first is safe — they are
  // tiny and effectively immutable, and revalidation refreshes them anyway.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          const contentType = response.headers.get('content-type') || '';
          // Same trap as the precache: the SPA fallback returns 200 + HTML for
          // a missing asset. Caching that would serve an HTML document as an
          // icon indefinitely. A non-navigation request never legitimately
          // wants text/html here.
          const isSpaFallback = contentType.includes('text/html');
          if (response.status === 200 && response.type === 'basic' && !isSpaFallback) {
            const copy = response.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

// Lets the page trigger an immediate takeover after an update is detected.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
