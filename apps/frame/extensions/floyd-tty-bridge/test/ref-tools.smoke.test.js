import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('ref-tools.js smoke test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.__floydElementMap = new Map();
    if (!window.__floydRefTools) {
      require('../ref-tools.js');
    }
  });

  it('click_ref succeeds for a live element ref', () => {
    const element = {
      dispatchEvent: vi.fn()
    };
    window.__floydElementMap.set('ref_1', { deref: () => element });

    const result = window.__floydRefTools.clickRef({ ref: 'ref_1' });

    expect(result.success).toBe(true);
    expect(result.ref).toBe('ref_1');
    expect(element.dispatchEvent).toHaveBeenCalledTimes(2);
    expect(element.dispatchEvent.mock.calls[0][0].type).toBe('mousedown');
    expect(element.dispatchEvent.mock.calls[1][0].type).toBe('click');
  });

  it('type_ref succeeds for a live input ref', () => {
    const element = {
      value: '',
      focus: vi.fn(),
      dispatchEvent: vi.fn()
    };
    window.__floydElementMap.set('ref_2', { deref: () => element });

    const result = window.__floydRefTools.typeRef({ ref: 'ref_2', text: 'hello world' });

    expect(result.success).toBe(true);
    expect(result.value).toBe('hello world');
    expect(element.focus).toHaveBeenCalledTimes(1);
    expect(element.value).toBe('hello world');
    expect(element.dispatchEvent).toHaveBeenCalledTimes(2);
    expect(element.dispatchEvent.mock.calls[0][0].type).toBe('input');
    expect(element.dispatchEvent.mock.calls[1][0].type).toBe('change');
  });

  it('scroll_to_ref succeeds for a live element ref', () => {
    const element = {
      scrollIntoView: vi.fn()
    };
    window.__floydElementMap.set('ref_3', { deref: () => element });

    const result = window.__floydRefTools.scrollToRef({ ref: 'ref_3' });

    expect(result.success).toBe(true);
    expect(element.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });

  it('returns dead-ref error when weak ref is cleared', () => {
    window.__floydElementMap.set('ref_99', { deref: () => null });

    const result = window.__floydRefTools.clickRef({ ref: 'ref_99' });

    expect(result).toEqual({ success: false, error: 'Element ref_99 no longer exists in DOM' });
    expect(window.__floydElementMap.has('ref_99')).toBe(false);
  });
});
