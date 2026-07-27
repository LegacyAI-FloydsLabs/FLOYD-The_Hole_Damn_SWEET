/**
 * Session manager — multi-session tabs and session rename for TerminalOne.
 *
 * ShellFish parity: switch between named sessions, rename a session.
 *
 * Note: TerminalOne currently has one live WebSocket per page. This module
 * keeps a small client-side registry of sessions and lets the user switch by
 * opening the named session id. The server supports resume, so switching to
 * an existing session re-attaches the PTY.
 */
const LS_NAMES = 'terminalone.sessionNames';
const MAX_SESSIONS = 5;

export function init(T1) {
  const header = document.querySelector('.terminal-header');
  if (!header) return;

  const names = readNames();
  let activeId = null;
  let switchCallback = typeof window.__terminalOne?.switchSession === 'function'
    ? window.__terminalOne.switchSession
    : null;

  T1.ui.addStyle(`
    .t1session-tabs {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-left: 12px;
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
    }
    .t1session-tab {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      font-size: 11px;
      background: var(--ui-bg);
      border: 1px solid var(--ui-border);
      border-radius: 4px;
      color: var(--ui-muted);
      cursor: pointer;
      white-space: nowrap;
      user-select: none;
    }
    .t1session-tab.active {
      color: var(--ui-fg);
      border-color: var(--ui-accent);
    }
    .t1session-tab input {
      width: 80px;
      background: transparent;
      border: none;
      color: inherit;
      font: inherit;
      padding: 0;
      outline: none;
    }
    .t1session-new {
      font-size: 14px;
      line-height: 1;
      padding: 3px 6px;
    }
  `);

  const tabsEl = document.createElement('div');
  tabsEl.className = 't1session-tabs';
  // Insert after the title.
  const title = header.querySelector('.terminal-title');
  title?.parentNode?.insertBefore(tabsEl, title.nextSibling);

  function readNames() {
    try { return JSON.parse(T1.storage.get(LS_NAMES, '{}')); } catch (_) { return {}; }
  }
  function writeNames(n) {
    try { T1.storage.set(LS_NAMES, JSON.stringify(n)); } catch (_) {}
  }

  function setName(id, newName) {
    if (!id) return;
    names[id] = newName || id.slice(0, 8);
    writeNames(names);
    render();
  }

  function render() {
    tabsEl.innerHTML = '';
    // Always show a tab for the active session.
    const ids = Object.keys(names);
    if (activeId && !names[activeId]) {
      names[activeId] = activeId.slice(0, 8);
      writeNames(names);
    }
    for (const id of ids.slice(-MAX_SESSIONS)) {
      const tab = document.createElement('div');
      tab.className = `t1session-tab ${id === activeId ? 'active' : ''}`;
      const span = document.createElement('span');
      span.textContent = names[id] || id.slice(0, 8);
      tab.appendChild(span);
      tab.addEventListener('click', (e) => {
        if (e.target === span) {
          if (id !== activeId && typeof switchCallback === 'function') switchCallback(id);
        }
      });
      tab.addEventListener('dblclick', () => {
        const input = document.createElement('input');
        input.value = span.textContent;
        tab.replaceChild(input, span);
        input.focus();
        input.select();
        const finish = () => { setName(id, input.value); };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(); if (e.key === 'Escape') render(); });
        input.addEventListener('blur', finish);
      });
      tabsEl.appendChild(tab);
    }
    const plus = document.createElement('button');
    plus.className = 't1session-tab t1session-new';
    plus.title = 'New session';
    plus.setAttribute('aria-label', 'New terminal session');
    plus.textContent = '+';
    plus.addEventListener('click', () => {
      if (typeof switchCallback === 'function') switchCallback('__new__');
    });
    tabsEl.appendChild(plus);
  }

  // Listen for active session changes.
  const infoEl = document.getElementById('sessionInfo');
  if (infoEl) {
    const observer = new MutationObserver(() => {
      const text = infoEl.textContent || '';
      const m = text.match(/session\s+([a-f0-9\-]+)/);
      if (m) {
        activeId = m[1];
        if (!names[activeId]) setName(activeId, activeId.slice(0, 8));
        else render();
      }
    });
    observer.observe(infoEl, { childList: true });
  }

  // Allow other modules to register the switch handler.
  window.__terminalOne = window.__terminalOne || {};
  window.__terminalOne.setSessionSwitchCallback = (cb) => { switchCallback = cb; };
  window.__terminalOne.renameSession = (id, name) => setName(id, name);
  window.__terminalOne.sessionNames = () => ({ ...names });

  render();
}
