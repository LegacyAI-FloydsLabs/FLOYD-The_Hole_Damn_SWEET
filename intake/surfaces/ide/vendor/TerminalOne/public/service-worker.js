/* TerminalOne service worker — offline shell only. */
const CACHE_NAME = 'terminalone-shell-v1';
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
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).catch(() => caches.match('/index.html'));
    })
  );
});
