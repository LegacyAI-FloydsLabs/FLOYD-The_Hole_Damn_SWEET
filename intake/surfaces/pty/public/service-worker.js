/* TerminalOne service worker — offline shell only. */
const CACHE_NAME = 'terminalone-shell-v5';
const OFFLINE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/node_modules/@xterm/xterm/css/xterm.css',
  '/node_modules/@xterm/xterm/lib/xterm.mjs',
  '/node_modules/@xterm/addon-fit/lib/addon-fit.mjs',
  '/node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(OFFLINE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const networkOnlyRequest = url.origin === self.location.origin
    && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin/') || url.pathname === '/health');
  const appShellRequest = event.request.mode === 'navigate'
    || (url.origin === self.location.origin && ['/', '/index.html'].includes(url.pathname));
  const featureModuleRequest = url.origin === self.location.origin
    && url.pathname.startsWith('/features/')
    && url.pathname.endsWith('.mjs');

  // Never clone or cache live application traffic. In particular, cache.put()
  // cannot complete for an open SSE body; retaining those clones eventually
  // exhausts the browser's per-origin connection pool.
  if (networkOnlyRequest) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (appShellRequest) {
    event.respondWith((async () => {
      try {
        // Release the current shell directly to the browser. The versioned
        // install cache already provides the offline fallback, so navigation
        // never needs to wait on a second Cache Storage write.
        return await fetch(event.request, { cache: 'no-store' });
      } catch (_) {
        return (await caches.match(event.request)) || caches.match('/index.html');
      }
    })());
    return;
  }

  // Feature modules contain command and safety behavior. Always prefer current
  // source so an older cached snippet can never outlive a deployed repair.
  if (featureModuleRequest) {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request, { cache: 'no-store' });
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(event.request, response.clone());
        }
        return response;
      } catch (_) {
        return caches.match(event.request);
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    const contentType = response.headers.get('content-type') || '';
    if (response.ok && url.origin === self.location.origin && !contentType.includes('text/event-stream')) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(event.request, response.clone());
    }
    return response;
  })());
});
