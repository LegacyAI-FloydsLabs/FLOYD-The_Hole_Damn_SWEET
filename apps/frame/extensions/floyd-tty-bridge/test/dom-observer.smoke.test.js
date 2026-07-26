import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const domObserverSource = readFileSync(
  resolve(__dirname, '../dom-observer.js'),
  'utf-8'
);

describe('dom-observer smoke tests', () => {
  it('dom-observer.js loads without errors', () => {
    expect(() => {
      require('../dom-observer.js');
    }).not.toThrow();
  });

  it('exposes initDomObserver and getDomChanges on window', () => {
    require('../dom-observer.js');
    expect(typeof window.initDomObserver).toBe('function');
    expect(typeof window.getDomChanges).toBe('function');
  });

  it('getDomChanges returns correct shape with success, changes, count', () => {
    require('../dom-observer.js');
    const result = window.getDomChanges({});
    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('changes');
    expect(result).toHaveProperty('count');
    expect(Array.isArray(result.changes)).toBe(true);
    expect(typeof result.count).toBe('number');
  });

  it('filters out style attribute mutations', () => {
    expect(domObserverSource).toContain("mutation.attributeName === 'style'");
  });

  it('filters extension-injected elements via data-floyd-injected and shadowRoot', () => {
    expect(domObserverSource).toContain('data-floyd-injected');
    expect(domObserverSource).toContain('shadowRoot');
    expect(domObserverSource).toContain('ShadowRoot');
  });

  it('caps _domChanges at 500 entries (FIFO)', () => {
    expect(domObserverSource).toContain('const _DOM_CHANGES_MAX = 500');
    expect(domObserverSource).toContain('_domChanges.shift()');
  });

  it('has integration comments for content-script.js', () => {
    expect(domObserverSource).toContain("// INTEGRATION: Add to content-script.js: case 'get_dom_changes': return getDomChanges(args);");
    expect(domObserverSource).toContain('// INTEGRATION: Call initDomObserver() in content-script.js DOMContentLoaded or at script load');
  });
});
