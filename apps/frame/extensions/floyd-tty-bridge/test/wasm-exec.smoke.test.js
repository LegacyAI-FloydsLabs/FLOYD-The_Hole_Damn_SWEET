import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('WASM execute smoke tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('computes SHA-256 digest for input text', async () => {
    const { computeSHA256 } = await import('../wasm/sha256-loader.js');
    const digest = await computeSHA256('hello world');

    expect(digest).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('initializes the WASM canary module', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('fetch unavailable'));
    const { ensureWasmCanary } = await import('../wasm/sha256-loader.js');
    const canaryStatus = await ensureWasmCanary();

    expect(canaryStatus).toEqual({ ok: true, canaryValue: 42 });
  });

  it('routes WASM_EXECUTE messages through offscreen listener', async () => {
    const { computeSHA256 } = await import('../wasm/sha256-loader.js');
    await import('../offscreen.js');

    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalled();
    const listener = chrome.runtime.onMessage.addListener.mock.calls.at(-1)[0];
    const sendResponse = vi.fn();

    const isAsync = listener(
      { type: 'WASM_EXECUTE', data: { module: 'hash', input: 'abc' } },
      {},
      sendResponse
    );

    expect(isAsync).toBe(true);
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledTimes(1);
    });
    const payload = sendResponse.mock.calls[0][0];

    expect(payload.success).toBe(true);
    expect(payload.module).toBe('hash');
    expect(payload.result).toBe(await computeSHA256('abc'));
    expect(typeof payload.executionTimeMs).toBe('number');
  });
});
