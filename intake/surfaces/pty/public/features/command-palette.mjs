/**
 * Command palette — Ctrl+Shift+P style overlay for TerminalOne actions.
 * Lists themes, styles, and feature actions; filters as you type.
 */
export function init(T1) {
  const shell = T1.ui.appShell() || document.body;

  T1.ui.addStyle(`
    .t1palette {
      position: fixed;
      inset: 0;
      z-index: 500;
      display: none;
      align-items: flex-start;
      justify-content: center;
      padding-top: 18vh;
      background: rgba(0,0,0,0.55);
      backdrop-filter: blur(3px);
    }
    .t1palette.open { display: flex; }
    .t1palette-box {
      width: 90%;
      max-width: 480px;
      background: var(--ui-elevated);
      border: 1px solid var(--ui-border);
      border-radius: 10px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
      overflow: hidden;
    }
    .t1palette-input {
      width: 100%;
      background: transparent;
      border: none;
      border-bottom: 1px solid var(--ui-border);
      color: var(--ui-fg);
      font-family: inherit;
      font-size: 15px;
      padding: 14px 16px;
      outline: none;
    }
    .t1palette-input:focus { border-bottom-color: var(--ui-accent); }
    .t1palette-list {
      max-height: 50vh;
      overflow-y: auto;
      padding: 6px;
    }
    .t1palette-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      text-align: left;
      background: transparent;
      border: none;
      border-radius: 6px;
      color: var(--ui-fg);
      font-family: inherit;
      font-size: 13px;
      padding: 8px 10px;
      cursor: pointer;
    }
    .t1palette-item:hover, .t1palette-item.active {
      background: var(--ui-bg);
    }
    .t1palette-item .shortcut {
      color: var(--ui-muted);
      font-size: 11px;
    }
    .t1palette-empty { padding: 14px; color: var(--ui-muted); font-size: 13px; text-align: center; }
  `);

  const palette = document.createElement('div');
  palette.className = 't1palette';
  palette.setAttribute('role', 'dialog');
  palette.setAttribute('aria-label', 'Command palette');
  const box = document.createElement('div');
  box.className = 't1palette-box';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 't1palette-input';
  input.placeholder = 'Type a command…';
  const list = document.createElement('div');
  list.className = 't1palette-list';
  box.appendChild(input);
  box.appendChild(list);
  palette.appendChild(box);
  shell.appendChild(palette);

  function themeActions() {
    const out = [];
    if (window.__terminalOne && window.__terminalOne.themes) {
      for (const id of window.__terminalOne.themes()) {
        const opt = document.querySelector(`#themeSelect option[value="${id}"]`);
        const label = opt ? opt.textContent : id;
        out.push({
          title: `Theme: ${label}`,
          shortcut: '',
          run() {
            if (window.__terminalOne && window.__terminalOne.setTheme) {
              window.__terminalOne.setTheme(id);
            }
          }
        });
      }
    }
    return out;
  }

  function allActions() {
    return [
      { title: 'Clear screen', shortcut: 'Ctrl+K', run() { window.dispatchEvent(new CustomEvent('t1:action', { detail: { action: 'clear' } })); } },
      { title: 'Toggle search', shortcut: 'Ctrl+Shift+F', run() { window.dispatchEvent(new CustomEvent('t1:action', { detail: { action: 'toggle-search' } })); } },
      { title: 'Toggle snippets', shortcut: 'Ctrl+B', run() { window.dispatchEvent(new CustomEvent('t1:action', { detail: { action: 'toggle-snippets' } })); } },
      { title: 'Increase font size', shortcut: 'Ctrl++', run() { window.dispatchEvent(new CustomEvent('t1:action', { detail: { action: 'font-increase' } })); } },
      { title: 'Decrease font size', shortcut: 'Ctrl+-', run() { window.dispatchEvent(new CustomEvent('t1:action', { detail: { action: 'font-decrease' } })); } },
      { title: 'Open settings', shortcut: '', run() { document.getElementById('settingsBtn')?.click(); } },
      { title: 'Reconnect session', shortcut: '', run() { document.getElementById('reconnectBtn')?.click(); } },
      { title: 'Close connection', shortcut: '', run() { document.getElementById('closeBtn')?.click(); } },
      { title: 'Open help', shortcut: 'F1', run() { window.dispatchEvent(new CustomEvent('t1:action', { detail: { action: 'help' } })); } },
      ...themeActions()
    ];
  }

  let filtered = [];
  let selected = 0;

  function render() {
    const q = input.value.trim().toLowerCase();
    filtered = allActions().filter((a) => a.title.toLowerCase().includes(q));
    list.innerHTML = '';
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 't1palette-empty';
      empty.textContent = 'No matching commands';
      list.appendChild(empty);
      selected = 0;
      return;
    }
    selected = Math.max(0, Math.min(selected, filtered.length - 1));
    filtered.forEach((a, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 't1palette-item' + (i === selected ? ' active' : '');
      b.innerHTML = `<span>${a.title}</span>${a.shortcut ? `<span class="shortcut">${a.shortcut}</span>` : ''}`;
      b.addEventListener('click', () => { a.run(); close(); });
      list.appendChild(b);
    });
  }

  function open() {
    input.value = '';
    palette.classList.add('open');
    render();
    setTimeout(() => input.focus(), 0);
  }
  function close() { palette.classList.remove('open'); }

  input.addEventListener('input', () => { selected = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(selected + 1, filtered.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(selected - 1, 0); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); filtered[selected]?.run(); close(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  palette.addEventListener('click', (e) => { if (e.target === palette) close(); });

  // Listen for the global command-palette action.
  window.addEventListener('t1:action', (e) => {
    if ((e.detail || {}).action === 'command-palette') open();
  });

  // Direct keyboard shortcut (global).
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      open();
    }
  });
}
