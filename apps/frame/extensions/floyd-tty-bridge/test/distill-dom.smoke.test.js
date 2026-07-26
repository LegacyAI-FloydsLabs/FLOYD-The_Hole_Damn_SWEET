import { beforeEach, describe, expect, it, vi } from 'vitest';

function createElement(tag, options) {
  const config = options || {};
  const attrs = config.attrs || {};
  return {
    tagName: tag.toUpperCase(),
    id: config.id || '',
    className: config.className || '',
    value: config.value || '',
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    closest() {
      return config.closestResult || null;
    }
  };
}

describe('distill-dom.js smoke test', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    window.__floydElementMap = new Map();
    await import('../distill-dom.js');
  });

  it('registers distillDom on window', () => {
    expect(typeof window.distillDom).toBe('function');
  });

  it('filters text_only mode to content roles and tags', () => {
    const tree = [
      'document',
      '  heading "Welcome" [ref_1] level=1',
      '  generic "Intro text" [ref_2]',
      '  list "Highlights" [ref_3]',
      '  cell "Price" [ref_4]',
      '  navigation "Site menu" [ref_5]',
      '  generic "Sponsored" [ref_6]'
    ].join('\n');

    window.__generateAccessibilityTree = vi.fn(() => ({ tree }));
    window.__floydElementMap = new Map([
      ['ref_1', { deref: () => createElement('h1') }],
      ['ref_2', { deref: () => createElement('p') }],
      ['ref_3', { deref: () => createElement('ul') }],
      ['ref_4', { deref: () => createElement('td') }],
      ['ref_5', { deref: () => createElement('nav') }],
      ['ref_6', { deref: () => createElement('div', { className: 'ad-banner' }) }]
    ]);

    const result = window.distillDom({ mode: 'text_only' });
    expect(result.success).toBe(true);
    expect(result.mode).toBe('text_only');
    expect(result.content).toContain('heading "Welcome" [ref_1]');
    expect(result.content).toContain('generic "Intro text" [ref_2]');
    expect(result.content).toContain('list "Highlights" [ref_3]');
    expect(result.content).toContain('cell "Price" [ref_4]');
    expect(result.content).not.toContain('navigation "Site menu" [ref_5]');
    expect(result.content).not.toContain('generic "Sponsored" [ref_6]');
    expect(result.elementCount).toBe(4);
  });

  it('filters input_fields mode and appends field metadata', () => {
    const tree = [
      'document',
      '  textbox "Email" [ref_1]',
      '  button "Submit" [ref_2]',
      '  generic "Name" [ref_3]',
      '  form "Checkout"',
      '  heading "Ignored" [ref_4]'
    ].join('\n');

    window.__generateAccessibilityTree = vi.fn(() => ({ tree }));
    window.__floydElementMap = new Map([
      ['ref_1', { deref: () => createElement('input', { attrs: { type: 'email', placeholder: 'Email' }, value: 'a@b.com' }) }],
      ['ref_2', { deref: () => createElement('button') }],
      ['ref_3', { deref: () => createElement('label') }],
      ['ref_4', { deref: () => createElement('h2') }]
    ]);

    const result = window.distillDom({ mode: 'input_fields' });
    expect(result.success).toBe(true);
    expect(result.mode).toBe('input_fields');
    expect(result.content).toContain('textbox "Email" [ref_1] type="email" placeholder="Email" value="a@b.com"');
    expect(result.content).toContain('button "Submit" [ref_2] type="button"');
    expect(result.content).toContain('generic "Name" [ref_3] type="label"');
    expect(result.content).toContain('form "Checkout" [ref_unavailable_4]');
    expect(result.content).not.toContain('heading "Ignored" [ref_4]');
    expect(result.elementCount).toBe(4);
  });

  it('returns full content for all_content mode', () => {
    const tree = 'document\n  heading "Welcome" [ref_1]\n  list "Highlights" [ref_2]';
    window.__generateAccessibilityTree = vi.fn(() => ({ tree }));

    const result = window.distillDom({ mode: 'all_content', depth: 2 });
    expect(window.__generateAccessibilityTree).toHaveBeenCalledWith(undefined, 2, undefined, undefined);
    expect(result.success).toBe(true);
    expect(result.mode).toBe('all_content');
    expect(result.content).toBe(tree);
    expect(result.elementCount).toBe(2);
    expect(result.estimatedTokens).toBe(Math.ceil(tree.length / 4));
  });

  it('returns error for invalid mode', () => {
    window.__generateAccessibilityTree = vi.fn(() => ({ tree: 'document' }));
    const result = window.distillDom({ mode: 'unsupported' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid mode');
  });

  it('returns generator errors', () => {
    window.__generateAccessibilityTree = vi.fn(() => ({ error: 'boom' }));
    const result = window.distillDom({ mode: 'text_only' });
    expect(result.success).toBe(false);
    expect(result.mode).toBe('text_only');
    expect(result.error).toBe('boom');
  });
});
