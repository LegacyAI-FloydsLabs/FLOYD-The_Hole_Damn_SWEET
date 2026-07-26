import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('quick-mode.js smoke test', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    window.document = document;
    window.location = { href: 'about:blank' };
    window.scrollBy = vi.fn();
    window.__generateAccessibilityTree = vi.fn(() => ({ tree: 'ok' }));
    window.distillDom = vi.fn(({ mode }) => ({ success: true, mode }));
    window.clickMark = vi.fn(({ mark }) => ({ success: true, mark }));
    await import('../quick-mode.js');
  });

  it('registers executeQuickCommands on window', () => {
    expect(typeof window.executeQuickCommands).toBe('function');
    expect(typeof window.__floydQuickMode.executeQuickCommands).toBe('function');
  });

  it('executes commands sequentially and returns aggregate result', async () => {
    const events = [];
    const target = {
      dispatchEvent: vi.fn((evt) => events.push(evt.type))
    };
    document.elementFromPoint = vi.fn(() => target);

    const result = await window.executeQuickCommands({
      commands: 'C 10 20\nW\nN https://example.com'
    });

    expect(document.elementFromPoint).toHaveBeenCalledWith(10, 20);
    expect(events).toEqual(['mousedown', 'mouseup', 'click']);
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(window.location.href).toBe('https://example.com');
    expect(result.success).toBe(true);
    expect(result.commandCount).toBe(3);
    expect(result.results).toHaveLength(3);
  });

  it('returns parse and validation errors without throwing', async () => {
    const result = await window.executeQuickCommands({
      commands: 'C 9\nS north 40\nQ'
    });

    expect(result.success).toBe(true);
    expect(result.commandCount).toBe(3);
    expect(result.results[0]).toEqual({ command: 'C', error: 'Missing coordinates' });
    expect(result.results[1]).toEqual({ command: 'S', error: 'Invalid direction' });
    expect(result.results[2]).toEqual({ command: 'Q', error: 'Missing query' });
  });

  it('types into active input and supports special key dispatch', async () => {
    const keyEvents = [];
    const inputEvents = [];
    const activeInput = {
      value: 'hello',
      dispatchEvent: vi.fn((evt) => {
        if (evt.type === 'keydown' || evt.type === 'keyup') keyEvents.push(evt.key);
        if (evt.type === 'input') inputEvents.push('input');
      })
    };
    document.activeElement = activeInput;

    const result = await window.executeQuickCommands({
      commands: 'T world\nK Enter\nK Backspace'
    });

    expect(activeInput.value).toBe('worl');
    expect(inputEvents.length).toBe(2);
    expect(keyEvents).toEqual(['Enter', 'Enter', 'Backspace', 'Backspace']);
    expect(result.commandCount).toBe(3);
  });

  it('supports R, D, M, P, Q, and X command outputs', async () => {
    const result = await window.executeQuickCommands({
      commands: 'R\nD text_only\nM 7\nP\nQ docs\nX return 2 + 3;'
    });

    expect(window.__generateAccessibilityTree).toHaveBeenCalledTimes(1);
    expect(window.distillDom).toHaveBeenCalledWith({ mode: 'text_only' });
    expect(window.clickMark).toHaveBeenCalledWith({ mark: 7 });
    expect(result.results[0]).toEqual({ tree: 'ok' });
    expect(result.results[1]).toEqual({ success: true, mode: 'text_only' });
    expect(result.results[2]).toEqual({ success: true, mark: 7 });
    expect(result.results[3]).toEqual({ action: 'screenshot' });
    expect(result.results[4]).toEqual({ action: 'query_knowledge', query: 'docs' });
    expect(result.results[5]).toEqual({ command: 'X', success: true, value: 5 });
  });
});
