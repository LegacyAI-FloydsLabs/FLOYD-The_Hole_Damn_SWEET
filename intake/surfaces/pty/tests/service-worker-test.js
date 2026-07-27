#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'service-worker.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function response(label, contentType = 'text/plain') {
  return {
    label,
    ok: true,
    headers: { get(name) { return name.toLowerCase() === 'content-type' ? contentType : null; } },
    clone() { return response(label, contentType); }
  };
}

async function runFetch({ mode, pathname, cached, networkError = null, networkResponse = null }) {
  const listeners = {};
  const puts = [];
  let fetchCount = 0;
  const request = { method: 'GET', mode, url: `http://127.0.0.1:11001${pathname}` };
  const context = {
    URL,
    self: {
      location: { origin: 'http://127.0.0.1:11001' },
      addEventListener(type, listener) { listeners[type] = listener; },
      skipWaiting() {},
      clients: { claim() {} }
    },
    caches: {
      async match(key) {
        const target = typeof key === 'string' ? key : new URL(key.url).pathname;
        return cached[target] || null;
      },
      async open() { return { addAll() {}, async put(key, value) { puts.push({ key, value }); } }; },
      async keys() { return []; },
      async delete() { return true; }
    },
    async fetch() {
      fetchCount += 1;
      if (networkError) throw networkError;
      return networkResponse || response('network-current');
    }
  };
  vm.runInNewContext(source, context, { filename: 'service-worker.js' });
  let resultPromise;
  listeners.fetch({ request, respondWith(value) { resultPromise = Promise.resolve(value); } });
  return { result: await resultPromise, fetchCount, puts };
}

async function main() {
  assert.match(source, /terminalone-shell-v5/);
  assert.doesNotMatch(source, /terminalone-shell-v[1-4]['"]/);
  assert.match(html, /updateViaCache: 'none'/);
  assert.doesNotMatch(html, /controllerchange[\s\S]*location\.reload\(\)/, 'worker activation must not reload an active terminal page');

  const current = await runFetch({
    mode: 'navigate',
    pathname: '/',
    cached: { '/': response('stale-cache'), '/index.html': response('offline-shell') }
  });
  assert.equal(current.fetchCount, 1, 'navigation consults the network even when a stale shell is cached');
  assert.equal(current.result.label, 'network-current', 'network response wins over the stale cached shell');
  assert.equal(current.puts.length, 0, 'navigation response bodies are not retained for a cache write');

  const offline = await runFetch({
    mode: 'navigate',
    pathname: '/workspace',
    cached: { '/index.html': response('offline-shell') },
    networkError: new Error('offline')
  });
  assert.equal(offline.result.label, 'offline-shell', 'navigation preserves the cached offline fallback');

  assert.doesNotMatch(source, /OFFLINE_ASSETS[\s\S]*['"]\/service-worker\.js['"]/, 'worker script must not be pinned in the offline asset cache');

  assert.ok(source.indexOf('if (networkOnlyRequest)') < source.indexOf('if (appShellRequest)'), 'network-only application routes must precede cache handling');
  const apiStream = await runFetch({
    mode: 'same-origin',
    pathname: '/api/floyd/experience/stream',
    cached: { '/api/floyd/experience/stream': response('stale-stream') },
    networkResponse: response('live-stream', 'text/event-stream')
  });
  assert.equal(apiStream.fetchCount, 1, 'API stream bypasses cache lookup and goes directly to network');
  assert.equal(apiStream.result.label, 'live-stream');
  assert.equal(apiStream.puts.length, 0, 'API stream response is never cloned into Cache Storage');

  const sseBackstop = await runFetch({
    mode: 'same-origin',
    pathname: '/events',
    cached: {},
    networkResponse: response('live-stream', 'text/event-stream; charset=utf-8')
  });
  assert.equal(sseBackstop.puts.length, 0, 'SSE content-type backstop prevents caching outside known API paths');

  const currentFeature = await runFetch({
    mode: 'same-origin',
    pathname: '/features/snippets.mjs',
    cached: { '/features/snippets.mjs': response('stale-command-module', 'application/javascript') },
    networkResponse: response('current-command-module', 'application/javascript')
  });
  assert.equal(currentFeature.fetchCount, 1, 'feature modules consult the network even when an older command module is cached');
  assert.equal(currentFeature.result.label, 'current-command-module', 'current feature module wins over stale cached behavior');
  assert.equal(currentFeature.puts.length, 1, 'current feature module refreshes its offline fallback');

  const offlineFeature = await runFetch({
    mode: 'same-origin',
    pathname: '/features/snippets.mjs',
    cached: { '/features/snippets.mjs': response('offline-command-module', 'application/javascript') },
    networkError: new Error('offline')
  });
  assert.equal(offlineFeature.result.label, 'offline-command-module', 'feature module retains an offline fallback');

  const staticAsset = await runFetch({
    mode: 'same-origin',
    pathname: '/node_modules/@xterm/xterm/lib/xterm.mjs',
    cached: { '/node_modules/@xterm/xterm/lib/xterm.mjs': response('cached-static') }
  });
  assert.equal(staticAsset.fetchCount, 0, 'static assets retain cache-first offline behavior');
  assert.equal(staticAsset.result.label, 'cached-static');

  console.log('PASS service worker network-first app shell and feature modules, network-only live streams, offline fallback, and static caching');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
