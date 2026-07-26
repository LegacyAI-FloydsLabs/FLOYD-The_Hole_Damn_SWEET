import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Use Case 1: Active Co-Development', () => {
  let sidepanelModule;
  let backgroundModule;
  let port;
  let nativePort;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    globalThis.__FLOYD_TEST__ = true;

    // Mock Side Panel Elements
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

    // Mock Native Port
    nativePort = {
      postMessage: vi.fn(),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
      disconnect: vi.fn()
    };
    vi.spyOn(chrome.runtime, 'connectNative').mockReturnValue(nativePort);

    // Mock tabs query for reload
    vi.spyOn(chrome.tabs, 'query').mockImplementation((query, callback) => {
      callback([{ id: 123 }]);
    });

    // Load modules
    backgroundModule = await import('../background.js');
    
    // Manually trigger background connection if needed, but background.js usually 
    // waits for a panel connection to connectNative().
    const onConnectCalls = chrome.runtime.onConnect.addListener.mock.calls;
    if (onConnectCalls.length > 0) {
      const onConnectListener = onConnectCalls[0][0];
      onConnectListener({ 
        name: 'floyd-tty-panel', 
        onMessage: { addListener: vi.fn() }, 
        onDisconnect: { addListener: vi.fn() }, 
        postMessage: vi.fn() 
      });
    }

    // Small delay for async init
    await new Promise(r => setTimeout(r, 100));
  });

  it('initializes the terminal and connects to the native host', async () => {
    await vi.waitFor(() => {
      expect(chrome.runtime.connectNative).toHaveBeenCalledWith('com.floyd.tty');
    });
  });

  it('triggers a browser reload when "refresh_tab" is received from the shell', async () => {
    await vi.waitFor(() => {
      expect(chrome.runtime.connectNative).toHaveBeenCalled();
    });
    
    // Locate the onMessage listener for the native port
    const onMessageListener = nativePort.onMessage.addListener.mock.calls[0][0];
    
    await onMessageListener({ type: 'refresh_tab' });

    expect(chrome.tabs.reload).toHaveBeenCalledWith(123);
  });

  it('triggers a browser reload when a file change is detected by the host', async () => {
    await vi.waitFor(() => {
      expect(chrome.runtime.connectNative).toHaveBeenCalled();
    });

    const onMessageListener = nativePort.onMessage.addListener.mock.calls[0][0];
    
    await onMessageListener({ type: 'file_changed', path: '/some/path' });

    expect(chrome.tabs.reload).toHaveBeenCalledWith(123);
  });
});
