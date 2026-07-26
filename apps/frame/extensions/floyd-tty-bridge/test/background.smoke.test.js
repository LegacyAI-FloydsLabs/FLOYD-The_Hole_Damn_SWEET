import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('background.js smoke test', () => {
  let backgroundModule;
  let nativePort;
  let panelPort;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    globalThis.__FLOYD_TEST__ = true;

    chrome.permissions.contains.mockResolvedValue(true);
    chrome.tabs.query.mockResolvedValue([{ id: 42, active: true }]);

    nativePort = {
      postMessage: vi.fn(),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
      disconnect: vi.fn()
    };
    panelPort = {
      name: 'floyd-tty-panel',
      postMessage: vi.fn(),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
      disconnect: vi.fn()
    };

    chrome.runtime.connectNative.mockReturnValue(nativePort);

    backgroundModule = await import('../background.js');
  });

  it('should load without errors', async () => {
    expect(backgroundModule).toBeDefined();
  });

  it('should be a valid JavaScript file', async () => {
    expect(backgroundModule).toBeDefined();
  });

  it('should have chrome API available', async () => {
    expect(chrome).toBeDefined();
    expect(chrome.runtime).toBeDefined();
  });

  it('should have sidePanel API available', async () => {
    expect(chrome.sidePanel).toBeDefined();
  });

  it('forwards ragbot_request from native host to the side panel', async () => {
    globalThis.__floydBackgroundTest.setPanelPort(panelPort);
    globalThis.__floydBackgroundTest.setNativePort(nativePort);

    await globalThis.__floydBackgroundTest.handleNativeMessage({ type: 'ragbot_request', requestId: 'rag_1', query: 'describe the page' });

    expect(panelPort.postMessage).toHaveBeenCalledWith({
      type: 'ragbot_request',
      requestId: 'rag_1',
      query: 'describe the page'
    });
  });

  it('forwards ragbot_response from side panel back to the native host', async () => {
    globalThis.__floydBackgroundTest.setPanelPort(panelPort);
    globalThis.__floydBackgroundTest.setNativePort(nativePort);

    globalThis.__floydBackgroundTest.handlePanelMessage(panelPort, {
      type: 'ragbot_response',
      requestId: 'rag_2',
      success: true,
      result: { text: 'Header overlaps nav bar.' }
    });

    expect(nativePort.postMessage).toHaveBeenCalledWith({
      type: 'ragbot_response',
      requestId: 'rag_2',
      success: true,
      result: { text: 'Header overlaps nav bar.' }
    });
  });
});
