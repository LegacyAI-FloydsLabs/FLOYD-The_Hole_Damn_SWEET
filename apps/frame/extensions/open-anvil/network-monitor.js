// network-monitor.js — CDP Network Traffic Capture with Ring Buffer
'use strict';

(function initNetworkMonitor(globalScope) {
  const MAX_BUFFER_SIZE = 500;
  const IDLE_TIMEOUT_MS = 60_000; // 60s idle → auto-detach
  const PROTOCOL_VERSION = '1.3';

  // ─── State ──────────────────────────────────────────────────────────────────
  let monitoredTabId = null;
  let monitoring = false;
  let idleDetached = false;
  let idleTimer = null;
  let eventListenerBound = false;

  /** @type {Array<{id:string, method:string, url:string, status:number|null, statusText:string|null, mimeType:string|null, timing:{startTime:number|null, endTime:number|null, duration:number|null}, size:{encoded:number|null, decoded:number|null}, timestamp:number}>} */
  const buffer = [];

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function fromChromeCallback(invoker) {
    return new Promise((resolve, reject) => {
      invoker((result) => {
        const err = chrome.runtime?.lastError;
        if (err) {
          reject(new Error(err.message || 'Chrome runtime error'));
          return;
        }
        resolve(result);
      });
    });
  }

  function findEntry(requestId) {
    for (let i = buffer.length - 1; i >= 0; i--) {
      if (buffer[i].id === requestId) return buffer[i];
    }
    return null;
  }

  function globToRegex(pattern) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped.replace(/\*/g, '.*'), 'i');
  }

  // ─── Idle Timeout ───────────────────────────────────────────────────────────

  function resetIdleTimer() {
    if (idleTimer != null) clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      const savedTabId = monitoredTabId;
      idleDetached = true;
      await doDetach();
      // Preserve tabId for re-attach on next readNetwork
      monitoredTabId = savedTabId;
    }, IDLE_TIMEOUT_MS);
  }

  // ─── Ring Buffer ────────────────────────────────────────────────────────────

  function pushToBuffer(entry) {
    if (buffer.length >= MAX_BUFFER_SIZE) {
      buffer.shift();
    }
    buffer.push(entry);
    resetIdleTimer();
  }

  // ─── CDP Event Handler ──────────────────────────────────────────────────────

  function handleDebuggerEvent(source, method, params) {
    if (!monitoring || !source || source.tabId !== monitoredTabId) return;

    if (method === 'Network.requestWillBeSent') {
      const { requestId, request, timestamp } = params;
      pushToBuffer({
        id: requestId,
        method: request.method,
        url: request.url,
        status: null,
        statusText: null,
        mimeType: null,
        timing: { startTime: timestamp, endTime: null, duration: null },
        size: { encoded: null, decoded: null },
        timestamp: Date.now()
      });
      return;
    }

    if (method === 'Network.responseReceived') {
      const { requestId, response } = params;
      const entry = findEntry(requestId);
      if (!entry) return;
      entry.status = response.status;
      entry.statusText = response.statusText;
      entry.mimeType = response.mimeType;
      if (response.timing) {
        entry.timing.endTime = response.timing.receiveHeadersEnd || null;
      }
      entry.size.encoded = response.encodedDataLength || null;
      if (response.headers) {
        const cl = response.headers['content-length'] || response.headers['Content-Length'];
        if (cl) entry.size.decoded = parseInt(cl, 10) || null;
      }
      return;
    }

    if (method === 'Network.loadingFinished') {
      const { requestId, encodedDataLength, timestamp } = params;
      const entry = findEntry(requestId);
      if (!entry) return;
      entry.size.encoded = encodedDataLength;
      if (entry.timing.startTime != null && timestamp != null) {
        entry.timing.endTime = timestamp;
        entry.timing.duration = Math.round((timestamp - entry.timing.startTime) * 1000);
      }
    }
  }

  // ─── Core: Attach / Detach ──────────────────────────────────────────────────

  async function doDetach() {
    if (idleTimer != null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    if (eventListenerBound) {
      chrome.debugger.onEvent.removeListener(handleDebuggerEvent);
      eventListenerBound = false;
    }

    if (monitoredTabId != null) {
      try {
        await fromChromeCallback((done) => {
          chrome.debugger.detach({ tabId: monitoredTabId }, done);
        });
      } catch (_) {
        // Debugger may already be detached
      }
    }

    monitoring = false;
    monitoredTabId = null;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async function startNetworkMonitor(tabId) {
    if (typeof tabId !== 'number') {
      throw new Error('startNetworkMonitor requires a numeric tabId');
    }

    // Already monitoring same tab — reset idle timer only
    if (monitoring && monitoredTabId === tabId) {
      resetIdleTimer();
      return { success: true, monitoring: true, tabId, message: 'Already monitoring' };
    }

    // Monitoring different tab — stop first
    if (monitoring) {
      await doDetach();
    }

    // Attach debugger
    await fromChromeCallback((done) => {
      chrome.debugger.attach({ tabId }, PROTOCOL_VERSION, done);
    });

    // Enable Network domain
    await fromChromeCallback((done) => {
      chrome.debugger.sendCommand({ tabId }, 'Network.enable', {}, done);
    });

    monitoredTabId = tabId;
    monitoring = true;
    idleDetached = false;

    if (!eventListenerBound) {
      chrome.debugger.onEvent.addListener(handleDebuggerEvent);
      eventListenerBound = true;
    }

    resetIdleTimer();

    return { success: true, monitoring: true, tabId };
  }

  async function stopNetworkMonitor() {
    const tabId = monitoredTabId;
    await doDetach();
    idleDetached = false;
    monitoredTabId = null;
    return { success: true, monitoring: false, tabId };
  }

  async function readNetwork(args = {}) {
    const { urlPattern, limit, clear } = args;

    // Re-attach if we idle-detached (transparent to caller)
    if (idleDetached && monitoredTabId != null) {
      try {
        await startNetworkMonitor(monitoredTabId);
      } catch (_) {
        // Tab may be closed — return stale data
      }
    }

    let results = [...buffer];

    // Filter by URL glob pattern
    if (urlPattern) {
      const regex = globToRegex(urlPattern);
      results = results.filter((e) => regex.test(e.url));
    }

    // Limit to N most recent entries
    if (typeof limit === 'number' && limit > 0) {
      results = results.slice(-limit);
    }

    // Clear buffer if requested
    if (clear) {
      buffer.length = 0;
    }

    return {
      success: true,
      requests: results,
      count: results.length,
      monitoring
    };
  }

  // Export on globalThis for importScripts() usage in service worker
  globalScope.startNetworkMonitor = startNetworkMonitor;
  globalScope.stopNetworkMonitor = stopNetworkMonitor;
  globalScope.readNetwork = readNetwork;
})(globalThis);

// INTEGRATION: importScripts('network-monitor.js'); in background.js
// INTEGRATION: Add to background.js handleBrowserApiTool(): case 'read_network': return readNetwork(args); case 'start_network_monitor': return startNetworkMonitor(tabId); case 'stop_network_monitor': return stopNetworkMonitor();
