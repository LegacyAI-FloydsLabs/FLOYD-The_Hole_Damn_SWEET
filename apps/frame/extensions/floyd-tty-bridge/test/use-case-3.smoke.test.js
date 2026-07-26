import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Use Case 3: Cross-Reference Workflow', () => {
  let sidepanelModule;
  let backgroundModule;
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

    panelPort = {
      postMessage: vi.fn(),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() }
    };
    vi.spyOn(chrome.runtime, 'connect').mockReturnValue(panelPort);

    backgroundModule = await import('../background.js');
    sidepanelModule = await import('../sidepanel.js');

    await new Promise(r => setTimeout(r, 50));
  });

  it('correctly handles structured verification reports in write_observation', async () => {
    const sidepanelTest = globalThis.__floydSidepanelTest;
    
    // 1. Simulate a call to write_observation with type: verification_report
    // This happens when Floyd calls floyd_verify_claim in the shell
    await sidepanelTest.sendToolCall('write_observation', {
      type: 'verification_report',
      claim_id: 'CLAIM-001',
      claim_text: 'The system uses OAuth 2.0',
      source_doc: 'sales_deck.pdf',
      code_reference: 'src/auth.ts:42',
      status: 'verified',
      notes: 'Confirmed in AuthProvider implementation'
    });

    // 2. Verify that it was sent to the background script
    expect(panelPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool_call',
      tool: 'write_observation',
      args: expect.objectContaining({
        type: 'verification_report',
        claim_id: 'CLAIM-001'
      })
    }));
  });
});
