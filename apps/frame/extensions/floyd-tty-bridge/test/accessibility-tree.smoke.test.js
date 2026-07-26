import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('accessibility-tree.js smoke test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads without errors', async () => {
    expect(() => {
      require('../accessibility-tree.js');
    }).not.toThrow();
  });

  it('registers __generateAccessibilityTree on window', async () => {
    require('../accessibility-tree.js');
    expect(typeof window.__generateAccessibilityTree).toBe('function');
  });

  it('creates __floydElementMap', async () => {
    require('../accessibility-tree.js');
    expect(window.__floydElementMap).toBeDefined();
    expect(window.__floydElementMap instanceof Map).toBe(true);
  });

  it('creates __floydRefCounter', async () => {
    require('../accessibility-tree.js');
    expect(window.__floydRefCounter).toBeDefined();
    expect(typeof window.__floydRefCounter).toBe('number');
  });
});
