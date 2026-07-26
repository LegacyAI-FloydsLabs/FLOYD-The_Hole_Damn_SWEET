import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('content-script.js smoke test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should load without errors', async () => {
    expect(() => {
      require('../content-script.js');
    }).not.toThrow();
  });

  it('should set window.__TOM_EXTENSION_ID__', async () => {
    require('../content-script.js');
    expect(window.__TOM_EXTENSION_ID__).toBeDefined();
  });

  it('should have chrome API available', async () => {
    require('../content-script.js');
    expect(chrome).toBeDefined();
    expect(chrome.runtime).toBeDefined();
  });

  it('should have window object available', async () => {
    require('../content-script.js');
    expect(window).toBeDefined();
  });
});
