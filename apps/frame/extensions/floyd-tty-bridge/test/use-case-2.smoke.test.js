import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Use Case 2: Tom -> FLOYD Communication', () => {
  let sidepanelModule;
  let backgroundModule;
  let nativePort;
  let panelPort;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    globalThis.__FLOYD_TEST__ = true;

    // Mock UI Elements
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
      value: '',
      textContent: ''
    });
    document.getElementById.mockImplementation(() => makeElement());
    document.createElement.mockImplementation(() => makeElement());
    document.querySelectorAll.mockImplementation(() => []);
    document.body = document.body || { appendChild: vi.fn(), addEventListener: vi.fn() };

    // Mock Native Port
    nativePort = {
      postMessage: vi.fn(),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() }
    };
    vi.spyOn(chrome.runtime, 'connectNative').mockReturnValue(nativePort);

    // Mock panelPort (the one sidepanel.js uses to talk to background.js)
    panelPort = {
      postMessage: vi.fn(),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() }
    };
    vi.spyOn(chrome.runtime, 'connect').mockReturnValue(panelPort);

    // Load modules
    backgroundModule = await import('../background.js');
    sidepanelModule = await import('../sidepanel.js');

    // Trigger connection so 'port' is defined in sidepanel.js
    const onConnectListener = chrome.runtime.onConnect.addListener.mock.calls[0][0];
    onConnectListener({ 
      name: 'floyd-tty-panel', 
      onMessage: { addListener: vi.fn() }, 
      onDisconnect: { addListener: vi.fn() }, 
      postMessage: vi.fn() 
    });

    await new Promise(r => setTimeout(r, 50));
  });

  it('injects a shell command when Tom returns a "floyd_command" in tool results', async () => {
    const sidepanelTest = globalThis.__floydSidepanelTest;
    
    // We override sendToolCall to immediately return a successful result 
    // with a floyd_command, bypassing the actual port/timeout logic.
    sidepanelTest.sendToolCall = vi.fn().mockResolvedValue({
      success: true,
      result: {
        status: 'Done',
        floyd_command: 'ls -la'
      }
    });

    // 2. Call the executor
    await sidepanelTest.liveToolExecutor('some_tool', {});

    // 3. Verify that pty_input was sent to the background (and thus the host)
    expect(panelPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pty_input',
      data: 'ls -la\n'
    }));
  });
});
