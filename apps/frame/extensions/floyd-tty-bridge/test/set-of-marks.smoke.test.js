import { describe, it, expect, beforeEach, vi } from 'vitest';

function createMockElement(tagName, computedPosition = 'static') {
  const attributes = {};
  return {
    nodeType: 1,
    tagName: String(tagName || 'div').toUpperCase(),
    style: { position: '' },
    children: [],
    parentNode: null,
    __computedPosition: computedPosition,
    dispatchEvent: vi.fn(),
    setAttribute(name, value) {
      attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name);
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) {
        this.children.splice(index, 1);
      }
      child.parentNode = null;
      return child;
    }
  };
}

describe('set-of-marks.js smoke test', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    global.Node = { ELEMENT_NODE: 1 };
    global.window = global;
    global.window.window = global.window;
    global.window.getComputedStyle = vi.fn((element) => ({
      position: element.__computedPosition || 'static'
    }));

    global.document = {
      createElement: vi.fn((tag) => createMockElement(tag, 'static'))
    };

    global.window.__floydElementMap = new Map();

    if (!global.window.__floydSetOfMarks) {
      require('../set-of-marks.js');
    }

    global.window.setOfMarks({ show: false });
  });

  it('loads and exposes setOfMarks/clickMark', () => {
    expect(typeof window.setOfMarks).toBe('function');
    expect(typeof window.clickMark).toBe('function');
    expect(window.__floydSetOfMarks._markMap instanceof Map).toBe(true);
  });

  it('adds numbered marks for interactive refs by default', () => {
    const button = createMockElement('button');
    const link = createMockElement('a');
    const input = createMockElement('input');
    const select = createMockElement('select');
    const div = createMockElement('div');

    window.__floydElementMap.set('ref_1', { deref: () => button });
    window.__floydElementMap.set('ref_2', { deref: () => link });
    window.__floydElementMap.set('ref_3', { deref: () => input });
    window.__floydElementMap.set('ref_4', { deref: () => select });
    window.__floydElementMap.set('ref_5', { deref: () => div });

    const result = window.setOfMarks({ show: true });

    expect(result).toEqual({ success: true, marks: 4, filter: 'interactive' });
    expect(window.__floydSetOfMarks._markMap.get(1)).toBe('ref_1');
    expect(window.__floydSetOfMarks._markMap.get(4)).toBe('ref_4');

    const firstWrapper = button.children[0];
    const firstBadge = firstWrapper.children[0];
    expect(firstWrapper.getAttribute('data-floyd-injected')).toBe('true');
    expect(firstBadge.getAttribute('data-floyd-injected')).toBe('true');
    expect(firstBadge.getAttribute('data-floyd-mark')).toBe('1');
    expect(firstBadge.getAttribute('data-floyd-ref')).toBe('ref_1');
    expect(firstBadge.textContent).toBe('[1]');
    expect(firstBadge.style.background).toBe('rgba(30,30,30,0.85)');
    expect(firstBadge.style.fontSize).toBe('11px');
    expect(button.style.position).toBe('relative');
  });

  it('supports forms filter and all filter', () => {
    const form = createMockElement('form');
    const input = createMockElement('input');
    const button = createMockElement('button');
    const link = createMockElement('a');

    window.__floydElementMap.set('ref_10', { deref: () => form });
    window.__floydElementMap.set('ref_11', { deref: () => input });
    window.__floydElementMap.set('ref_12', { deref: () => button });
    window.__floydElementMap.set('ref_13', { deref: () => link });

    const formsResult = window.setOfMarks({ show: true, filter: 'forms' });
    expect(formsResult).toEqual({ success: true, marks: 3, filter: 'forms' });

    const allResult = window.setOfMarks({ show: true, filter: 'all' });
    expect(allResult).toEqual({ success: true, marks: 4, filter: 'all' });
  });

  it('removes all marks when show is false', () => {
    const button = createMockElement('button');
    window.__floydElementMap.set('ref_20', { deref: () => button });

    window.setOfMarks({ show: true });
    expect(button.children.length).toBe(1);

    const result = window.setOfMarks({ show: false });
    expect(result).toEqual({ success: true, marks: 0, filter: 'interactive' });
    expect(button.children.length).toBe(0);
    expect(window.__floydSetOfMarks._markMap.size).toBe(0);
    expect(button.style.position).toBe('');
  });

  it('clickMark dispatches mousedown and click using mark mapping', () => {
    const button = createMockElement('button', 'relative');
    window.__floydElementMap.set('ref_30', { deref: () => button });

    window.setOfMarks({ show: true, filter: 'all' });
    const result = window.clickMark({ mark: 1 });

    expect(result).toEqual({ success: true, mark: 1, ref: 'ref_30', tagName: 'button' });
    expect(button.dispatchEvent).toHaveBeenCalledTimes(2);
    expect(button.dispatchEvent.mock.calls[0][0].type).toBe('mousedown');
    expect(button.dispatchEvent.mock.calls[1][0].type).toBe('click');
  });

  it('clickMark returns error for unknown mark', () => {
    const result = window.clickMark({ mark: 999 });
    expect(result).toEqual({ success: false, error: 'Unknown mark: 999' });
  });
});
