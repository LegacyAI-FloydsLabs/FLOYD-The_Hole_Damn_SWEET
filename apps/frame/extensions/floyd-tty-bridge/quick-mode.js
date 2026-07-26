'use strict';

(function initQuickMode(globalScope) {
  const hostScope = globalScope.window && typeof globalScope.window === 'object'
    ? globalScope.window
    : globalScope;

  const SPECIAL_KEYS = {
    enter: 'Enter',
    tab: 'Tab',
    escape: 'Escape',
    esc: 'Escape',
    arrowup: 'ArrowUp',
    arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft',
    arrowright: 'ArrowRight',
    backspace: 'Backspace'
  };

  function getEventTarget() {
    if (hostScope.document && hostScope.document.activeElement) {
      return hostScope.document.activeElement;
    }
    return hostScope.document || hostScope;
  }

  function getActiveInputElement() {
    const active = hostScope.document && hostScope.document.activeElement;
    if (!active || typeof active !== 'object') return null;
    if (typeof active.value === 'string') return active;
    return null;
  }

  function dispatchMouse(type, element, x, y, button) {
    const mouseButton = typeof button === 'number' ? button : 0;
    if (typeof hostScope.MouseEvent === 'function') {
      element.dispatchEvent(new hostScope.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: hostScope,
        clientX: x,
        clientY: y,
        button: mouseButton,
        buttons: mouseButton === 2 ? 2 : 1
      }));
      return;
    }

    if (typeof globalScope.MouseEvent === 'function') {
      element.dispatchEvent(new globalScope.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: hostScope,
        clientX: x,
        clientY: y,
        button: mouseButton,
        buttons: mouseButton === 2 ? 2 : 1
      }));
      return;
    }

    element.dispatchEvent({ type, bubbles: true, cancelable: true, clientX: x, clientY: y, button: mouseButton });
  }

  function dispatchSimpleEvent(type, target) {
    if (typeof hostScope.Event === 'function') {
      target.dispatchEvent(new hostScope.Event(type, { bubbles: true }));
      return;
    }
    if (typeof globalScope.Event === 'function') {
      target.dispatchEvent(new globalScope.Event(type, { bubbles: true }));
      return;
    }
    target.dispatchEvent({ type, bubbles: true });
  }

  function dispatchKey(type, key, target) {
    if (typeof hostScope.KeyboardEvent === 'function') {
      target.dispatchEvent(new hostScope.KeyboardEvent(type, { bubbles: true, cancelable: true, key }));
      return;
    }
    if (typeof globalScope.KeyboardEvent === 'function') {
      target.dispatchEvent(new globalScope.KeyboardEvent(type, { bubbles: true, cancelable: true, key }));
      return;
    }
    target.dispatchEvent({ type, bubbles: true, cancelable: true, key });
  }

  function parsePoint(parts, command) {
    if (parts.length < 3) {
      return { error: { command, error: 'Missing coordinates' } };
    }
    const x = Number(parts[1]);
    const y = Number(parts[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { error: { command, error: 'Invalid coordinates' } };
    }
    return { x, y };
  }

  function parseDirection(parts) {
    if (parts.length < 3) {
      return { error: { command: 'S', error: 'Missing direction or amount' } };
    }
    const dir = String(parts[1] || '').toLowerCase();
    const amt = Number(parts[2]);
    if (!['up', 'down', 'left', 'right'].includes(dir)) {
      return { error: { command: 'S', error: 'Invalid direction' } };
    }
    if (!Number.isFinite(amt)) {
      return { error: { command: 'S', error: 'Invalid amount' } };
    }
    return { dir, amt };
  }

  function splitCommandLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    const firstSpace = trimmed.indexOf(' ');
    if (firstSpace === -1) {
      return { command: trimmed.toUpperCase(), args: '' };
    }
    return {
      command: trimmed.slice(0, firstSpace).toUpperCase(),
      args: trimmed.slice(firstSpace + 1).trim()
    };
  }

  async function runCommand(command, argString) {
    const parts = argString ? argString.split(/\s+/) : [];

    if (command === 'C' || command === 'RC' || command === 'DC' || command === 'H') {
      const point = parsePoint([command].concat(parts), command);
      if (point.error) return point.error;
      const elementFromPoint = hostScope.document && typeof hostScope.document.elementFromPoint === 'function'
        ? hostScope.document.elementFromPoint(point.x, point.y)
        : null;
      if (!elementFromPoint) {
        return { command, error: 'No element at coordinates' };
      }

      if (command === 'C') {
        dispatchMouse('mousedown', elementFromPoint, point.x, point.y, 0);
        dispatchMouse('mouseup', elementFromPoint, point.x, point.y, 0);
        dispatchMouse('click', elementFromPoint, point.x, point.y, 0);
        return { command: 'C', x: point.x, y: point.y, success: true };
      }

      if (command === 'RC') {
        dispatchMouse('mousedown', elementFromPoint, point.x, point.y, 2);
        dispatchMouse('mouseup', elementFromPoint, point.x, point.y, 2);
        dispatchMouse('contextmenu', elementFromPoint, point.x, point.y, 2);
        return { command: 'RC', x: point.x, y: point.y, success: true };
      }

      if (command === 'DC') {
        dispatchMouse('mousedown', elementFromPoint, point.x, point.y, 0);
        dispatchMouse('mouseup', elementFromPoint, point.x, point.y, 0);
        dispatchMouse('click', elementFromPoint, point.x, point.y, 0);
        dispatchMouse('mousedown', elementFromPoint, point.x, point.y, 0);
        dispatchMouse('mouseup', elementFromPoint, point.x, point.y, 0);
        dispatchMouse('click', elementFromPoint, point.x, point.y, 0);
        dispatchMouse('dblclick', elementFromPoint, point.x, point.y, 0);
        return { command: 'DC', x: point.x, y: point.y, success: true };
      }

      dispatchMouse('mouseover', elementFromPoint, point.x, point.y, 0);
      dispatchMouse('mouseenter', elementFromPoint, point.x, point.y, 0);
      dispatchMouse('mousemove', elementFromPoint, point.x, point.y, 0);
      return { command: 'H', x: point.x, y: point.y, success: true };
    }

    if (command === 'T') {
      if (!argString) return { command: 'T', error: 'Missing text' };
      const target = getActiveInputElement();
      if (!target) {
        return { command: 'T', error: 'No focused input element' };
      }
      target.value = argString;
      dispatchSimpleEvent('input', target);
      return { command: 'T', value: target.value, success: true };
    }

    if (command === 'K') {
      if (!argString) return { command: 'K', error: 'Missing keys' };
      const normalized = SPECIAL_KEYS[argString.toLowerCase()] || argString;
      const target = getEventTarget();
      dispatchKey('keydown', normalized, target);

      if (normalized === 'Backspace') {
        const input = getActiveInputElement();
        if (input) {
          input.value = input.value.slice(0, -1);
          dispatchSimpleEvent('input', input);
        }
      }

      dispatchKey('keyup', normalized, target);
      return { command: 'K', key: normalized, success: true };
    }

    if (command === 'S') {
      const parsed = parseDirection([command].concat(parts));
      if (parsed.error) return parsed.error;

      let dx = 0;
      let dy = 0;
      if (parsed.dir === 'up') dy = -parsed.amt;
      if (parsed.dir === 'down') dy = parsed.amt;
      if (parsed.dir === 'left') dx = -parsed.amt;
      if (parsed.dir === 'right') dx = parsed.amt;

      if (typeof hostScope.scrollBy === 'function') {
        hostScope.scrollBy(dx, dy);
      }
      return { command: 'S', dir: parsed.dir, amount: parsed.amt, success: true };
    }

    if (command === 'N') {
      if (!argString) return { command: 'N', error: 'Missing URL' };
      if (hostScope.location) {
        hostScope.location.href = argString;
      }
      return { command: 'N', navigating_to: argString, success: true };
    }

    if (command === 'W') {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return { command: 'W', waitedMs: 1000, success: true };
    }

    if (command === 'R') {
      if (typeof hostScope.__generateAccessibilityTree !== 'function') {
        return { command: 'R', error: '__generateAccessibilityTree is unavailable' };
      }
      return hostScope.__generateAccessibilityTree();
    }

    if (command === 'D') {
      if (!argString) return { command: 'D', error: 'Missing mode' };
      if (typeof hostScope.distillDom !== 'function') {
        return { command: 'D', error: 'distillDom is unavailable' };
      }
      return hostScope.distillDom({ mode: argString });
    }

    if (command === 'M') {
      if (!argString) return { command: 'M', error: 'Missing mark number' };
      const mark = Number(argString);
      if (!Number.isFinite(mark)) return { command: 'M', error: 'Invalid mark number' };
      if (typeof hostScope.clickMark !== 'function') {
        return { command: 'M', error: 'clickMark is unavailable' };
      }
      return hostScope.clickMark({ mark });
    }

    if (command === 'X') {
      if (!argString) return { command: 'X', error: 'Missing js_code' };
      try {
        const value = new Function(argString)();
        return { command: 'X', success: true, value };
      } catch (error) {
        return { command: 'X', error: error && error.message ? error.message : String(error) };
      }
    }

    if (command === 'P') {
      return { action: 'screenshot' };
    }

    if (command === 'Q') {
      if (!argString) return { command: 'Q', error: 'Missing query' };
      return { action: 'query_knowledge', query: argString };
    }

    return { command, error: 'Unknown quick command' };
  }

  async function executeQuickCommands(args) {
    const commandsText = args && typeof args.commands === 'string' ? args.commands : '';
    const lines = commandsText
      .split('\n')
      .map(function (line) { return line.trim(); })
      .filter(function (line) { return line.length > 0; });

    const results = [];
    for (let i = 0; i < lines.length; i += 1) {
      const parsed = splitCommandLine(lines[i]);
      if (!parsed) continue;
      const result = await runCommand(parsed.command, parsed.args);
      results.push(result);
    }

    return {
      success: true,
      results,
      commandCount: lines.length
    };
  }

  hostScope.executeQuickCommands = executeQuickCommands;
  hostScope.__floydQuickMode = { executeQuickCommands };
  if (hostScope !== globalScope) {
    globalScope.executeQuickCommands = executeQuickCommands;
    globalScope.__floydQuickMode = hostScope.__floydQuickMode;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { executeQuickCommands };
  }
})(globalThis);

// INTEGRATION: Add to content-script.js: case 'quick': return executeQuickCommands(args);
// INTEGRATION: Add to manifest.json content_scripts with run_at: document_start, all_frames: true
