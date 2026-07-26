import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('offscreen.js smoke test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should load without errors', async () => {
    expect(() => {
      require('../offscreen.js');
    }).not.toThrow();
  });

  it('should have chrome API available', async () => {
    require('../offscreen.js');
    expect(chrome).toBeDefined();
    expect(chrome.runtime).toBeDefined();
  });

  it('should have AudioContext available', async () => {
    require('../offscreen.js');
    expect(window.AudioContext).toBeDefined();
  });
});
