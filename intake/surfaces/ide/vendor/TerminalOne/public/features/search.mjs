/**
 * Scrollback search — find text in the terminal buffer via the xterm
 * SearchAddon. A fresh addon is attached on every (re)connect because the
 * terminal is recreated. The search box is a small overlay toggled from the
 * feature bar; Enter finds next, Shift+Enter finds previous, Esc closes.
 *
 * v2 adds case-sensitive and regex toggles so the global search behaves like
 * a modern editor find panel.
 */
import { SearchAddon } from '/node_modules/@xterm/addon-search/lib/addon-search.mjs';

export function init(T1) {
  const tb = T1.ui.toolbar();
  if (!tb) return;

  let addon = null;
  T1.onTermReady((term) => {
    try { addon = new SearchAddon(); term.loadAddon(addon); }
    catch (_) { addon = null; }
  });

  T1.ui.addStyle(`
    .t1search-box {
      position: absolute;
      top: 8px; right: 8px;
      z-index: 250;
      display: none;
      gap: 4px;
      align-items: center;
      padding: 6px;
      background: var(--ui-elevated);
      border: 1px solid var(--ui-border);
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.35);
    }
    .t1search-box.open { display: flex; }
    .t1search-input {
      background: var(--ui-bg);
      border: 1px solid var(--ui-border);
      border-radius: 6px;
      color: var(--ui-fg);
      font-family: inherit;
      font-size: 13px;
      padding: 4px 8px;
      width: 180px;
      outline: none;
    }
    .t1search-input:focus { border-color: var(--ui-accent); }
    .t1search-toggle {
      min-width: 28px;
      padding: 0 6px;
    }
    .t1search-toggle.active { background: var(--ui-accent); color: #000; }
  `);

  const state = { caseSensitive: false, regex: false };

  const box = document.createElement('div');
  box.className = 't1search-box';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 't1search-input';
  input.placeholder = 'Search scrollback';
  input.setAttribute('aria-label', 'Search scrollback');
  box.appendChild(input);

  const searchOptions = () => ({
    caseSensitive: state.caseSensitive,
    regex: state.regex,
    incremental: false,
    decorate: true
  });

  const next = () => {
    if (addon && input.value) {
      try { addon.findNext(input.value, searchOptions()); }
      catch (_) {
        try { addon.findNext(input.value); } catch (_) {}
      }
    }
  };
  const prev = () => {
    if (addon && input.value) {
      try { addon.findPrevious(input.value, searchOptions()); }
      catch (_) {
        try { addon.findPrevious(input.value); } catch (_) {}
      }
    }
  };

  const makeToggle = (label, title, key) => {
    const b = T1.ui.makeButton(label, title, () => {
      state[key] = !state[key];
      b.classList.toggle('active', state[key]);
      if (input.value) next();
    });
    b.classList.add('t1search-toggle');
    return b;
  };

  const caseToggle = makeToggle('Aa', 'Case sensitive', 'caseSensitive');
  const regexToggle = makeToggle('.*', 'Regular expression', 'regex');

  box.appendChild(caseToggle);
  box.appendChild(regexToggle);
  box.appendChild(T1.ui.makeButton('\u25c0', 'Previous match', prev));
  box.appendChild(T1.ui.makeButton('\u25b6', 'Next match', next));
  box.appendChild(T1.ui.makeButton('x', 'Close search', () => box.classList.remove('open')));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) prev(); else next(); }
    else if (e.key === 'Escape') { box.classList.remove('open'); }
  });

  const shell = T1.ui.appShell() || document.body;
  // The overlay is absolutely positioned; ensure the shell is a containing block.
  if (getComputedStyle(shell).position === 'static') shell.style.position = 'relative';
  shell.appendChild(box);

  const toggle = T1.ui.makeButton('Search', 'Search scrollback (Ctrl+Shift+F)', () => {
    const open = box.classList.toggle('open');
    if (open) setTimeout(() => input.focus(), 0);
  });
  tb.appendChild(toggle);

  // Global keyboard shortcut is handled by keyboard-shortcuts.mjs via t1:action.
  window.addEventListener('t1:action', (e) => {
    if ((e.detail || {}).action === 'toggle-search') {
      const open = box.classList.toggle('open');
      if (open) setTimeout(() => input.focus(), 0);
    }
  });
}
