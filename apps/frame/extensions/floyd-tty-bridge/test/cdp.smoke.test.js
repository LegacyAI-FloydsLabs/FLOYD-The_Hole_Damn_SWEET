import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('cdp.js smoke test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete globalThis.__floydCDP;
  });

  it('loads without errors', async () => {
    await expect(import('../cdp.js')).resolves.toBeDefined();
  });

  it('exposes __floydCDP on globalThis', async () => {
    await import('../cdp.js');
    expect(globalThis.__floydCDP).toBeDefined();
    expect(typeof globalThis.__floydCDP).toBe('object');
  });

  it('provides attach/detach/send/execute functions', async () => {
    await import('../cdp.js');
    expect(typeof globalThis.__floydCDP.attach).toBe('function');
    expect(typeof globalThis.__floydCDP.detach).toBe('function');
    expect(typeof globalThis.__floydCDP.send).toBe('function');
    expect(typeof globalThis.__floydCDP.execute).toBe('function');
  });
});
