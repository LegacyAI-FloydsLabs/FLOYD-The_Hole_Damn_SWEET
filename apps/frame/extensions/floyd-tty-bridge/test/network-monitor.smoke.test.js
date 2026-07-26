import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('network-monitor.js smoke test', () => {
  /** @type {Function|null} captured chrome.debugger.onEvent listener */
  let capturedEventListener = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.resetModules();

    // Clean up any prior global exports
    delete globalThis.startNetworkMonitor;
    delete globalThis.stopNetworkMonitor;
    delete globalThis.readNetwork;

    // Configure chrome.debugger mocks to invoke callbacks (simulating success)
    chrome.runtime.lastError = null;
    chrome.debugger.attach.mockImplementation((_target, _ver, cb) => cb());
    chrome.debugger.sendCommand.mockImplementation((_target, _method, _params, cb) => cb());
    chrome.debugger.detach.mockImplementation((_target, cb) => cb());

    // Capture the event listener registered on chrome.debugger.onEvent
    capturedEventListener = null;
    chrome.debugger.onEvent.addListener.mockImplementation((fn) => {
      capturedEventListener = fn;
    });
    chrome.debugger.onEvent.removeListener.mockImplementation(() => {
      capturedEventListener = null;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Helper: simulate CDP network events ────────────────────────────────

  function emitRequest(tabId, requestId, method, url, timestamp) {
    if (!capturedEventListener) throw new Error('No event listener captured');
    capturedEventListener(
      { tabId },
      'Network.requestWillBeSent',
      { requestId, request: { method, url }, timestamp }
    );
  }

  function emitResponse(tabId, requestId, status, statusText, mimeType, headers) {
    if (!capturedEventListener) throw new Error('No event listener captured');
    capturedEventListener(
      { tabId },
      'Network.responseReceived',
      {
        requestId,
        response: {
          status,
          statusText,
          mimeType,
          headers: headers || {},
          encodedDataLength: 1024,
          timing: { receiveHeadersEnd: 100.5 }
        }
      }
    );
  }

  // ─── Tests ──────────────────────────────────────────────────────────────

  it('loads and exposes startNetworkMonitor, stopNetworkMonitor, readNetwork', async () => {
    await import('../network-monitor.js');

    expect(typeof globalThis.startNetworkMonitor).toBe('function');
    expect(typeof globalThis.stopNetworkMonitor).toBe('function');
    expect(typeof globalThis.readNetwork).toBe('function');
  });

  it('startNetworkMonitor attaches debugger and enables Network domain', async () => {
    await import('../network-monitor.js');

    const result = await globalThis.startNetworkMonitor(42);

    expect(result).toEqual({ success: true, monitoring: true, tabId: 42 });
    expect(chrome.debugger.attach).toHaveBeenCalledWith(
      { tabId: 42 }, '1.3', expect.any(Function)
    );
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 42 }, 'Network.enable', {}, expect.any(Function)
    );
    expect(chrome.debugger.onEvent.addListener).toHaveBeenCalledWith(expect.any(Function));
  });

  it('captures request/response events into ring buffer via readNetwork', async () => {
    await import('../network-monitor.js');
    await globalThis.startNetworkMonitor(42);

    // Simulate a full request → response cycle
    emitRequest(42, 'req1', 'GET', 'https://example.com/api/data', 50.0);
    emitResponse(42, 'req1', 200, 'OK', 'application/json', { 'content-length': '2048' });

    const result = await globalThis.readNetwork({});

    expect(result.success).toBe(true);
    expect(result.monitoring).toBe(true);
    expect(result.count).toBe(1);

    const entry = result.requests[0];
    expect(entry.id).toBe('req1');
    expect(entry.method).toBe('GET');
    expect(entry.url).toBe('https://example.com/api/data');
    expect(entry.status).toBe(200);
    expect(entry.statusText).toBe('OK');
    expect(entry.mimeType).toBe('application/json');
    expect(entry.size.encoded).toBe(1024);
    expect(entry.size.decoded).toBe(2048);
  });

  it('readNetwork filters by urlPattern, limit, and clear', async () => {
    await import('../network-monitor.js');
    await globalThis.startNetworkMonitor(42);

    // Push 3 requests
    emitRequest(42, 'r1', 'GET', 'https://api.example.com/users', 1);
    emitRequest(42, 'r2', 'POST', 'https://api.example.com/auth/login', 2);
    emitRequest(42, 'r3', 'GET', 'https://cdn.example.com/image.png', 3);

    // Filter by pattern
    const filtered = await globalThis.readNetwork({ urlPattern: '*api.example*' });
    expect(filtered.count).toBe(2);
    expect(filtered.requests.map((r) => r.id)).toEqual(['r1', 'r2']);

    // Limit
    const limited = await globalThis.readNetwork({ limit: 1 });
    expect(limited.count).toBe(1);
    expect(limited.requests[0].id).toBe('r3'); // most recent

    // Clear
    const cleared = await globalThis.readNetwork({ clear: true });
    expect(cleared.count).toBe(3); // returns current before clearing

    // Verify buffer is empty after clear
    const empty = await globalThis.readNetwork({});
    expect(empty.count).toBe(0);
  });

  it('stopNetworkMonitor detaches debugger and cleans up', async () => {
    await import('../network-monitor.js');
    await globalThis.startNetworkMonitor(42);

    const result = await globalThis.stopNetworkMonitor();

    expect(result).toEqual({ success: true, monitoring: false, tabId: 42 });
    expect(chrome.debugger.detach).toHaveBeenCalledWith(
      { tabId: 42 }, expect.any(Function)
    );
    expect(chrome.debugger.onEvent.removeListener).toHaveBeenCalled();

    // readNetwork should report monitoring: false
    const read = await globalThis.readNetwork({});
    expect(read.monitoring).toBe(false);
  });
});
