import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('live-service.js smoke test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should load without errors', async () => {
    expect(async () => {
      await import('../live-service.js');
    }).not.toThrow();
  });

  it('should export LiveSession class', async () => {
    const module = await import('../live-service.js');
    expect(module.LiveSession).toBeDefined();
    expect(typeof module.LiveSession).toBe('function');
  });

  it('should have LiveSession as a class', async () => {
    const module = await import('../live-service.js');
    expect(module.LiveSession.prototype).toBeDefined();
  });
});
