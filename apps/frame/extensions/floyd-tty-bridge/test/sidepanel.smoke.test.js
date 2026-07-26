import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('sidepanel.js smoke test', () => {
  let sidepanelModule;
  let port;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    globalThis.__FLOYD_TEST__ = true;

    const makeElement = () => ({
      appendChild: vi.fn(),
      removeChild: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      focus: vi.fn(),
      contains: vi.fn(() => false),
      getBoundingClientRect: vi.fn(() => ({ width: 100, height: 20 })),
      classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
      style: {},
      clientWidth: 800,
      clientHeight: 600,
      value: '',
      textContent: '',
      className: ''
    });

    document.getElementById.mockImplementation(() => makeElement());
    document.createElement.mockImplementation(() => makeElement());
    document.querySelectorAll.mockImplementation(() => []);
    document.body = document.body || { appendChild: vi.fn(), addEventListener: vi.fn() };

    port = {
      postMessage: vi.fn(),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
      disconnect: vi.fn()
    };
    chrome.runtime.connect.mockReturnValue(port);

    sidepanelModule = await import('../sidepanel.js');
  });

  it('should load without errors', async () => {
    expect(sidepanelModule).toBeDefined();
  });

  it('should have Terminal available', async () => {
    expect(global.Terminal).toBeDefined();
  });

  it('should have chrome API available', async () => {
    expect(chrome).toBeDefined();
    expect(chrome.runtime).toBeDefined();
  });

  it('returns an error ragbot_response when Tom is not connected', async () => {
    globalThis.__floydSidepanelTest.setPort(port);

    await globalThis.__floydSidepanelTest.handleRagbotRequest({
      type: 'ragbot_request',
      requestId: 'rag_1',
      query: 'what do you see?'
    });

    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'ragbot_response',
      requestId: 'rag_1',
      success: false,
      error: 'Tom is not connected'
    });
  });
});
