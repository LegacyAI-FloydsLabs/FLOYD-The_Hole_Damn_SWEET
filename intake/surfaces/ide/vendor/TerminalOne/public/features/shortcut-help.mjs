/**
 * Keyboard shortcut helper overlay (tablet/desktop).
 *
 * Pressing ? or Cmd/Ctrl+? opens an overlay listing available shortcuts for
 * the current device.
 */
export function init(T1) {
  T1.ui.addStyle(`
    .t1-shortcut-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.5);
      z-index: 400;
      display: none; align-items: center; justify-content: center;
    }
    .t1-shortcut-overlay.open { display: flex; }
    .t1-shortcut-panel {
      background: var(--ui-elevated);
      border: 1px solid var(--ui-border);
      border-radius: 10px;
      width: min(520px, 90vw);
      max-height: 70vh;
      overflow: hidden;
      display: flex; flex-direction: column;
    }
    .t1-shortcut-panel header { padding: 14px 18px; border-bottom: 1px solid var(--ui-border); display: flex; justify-content: space-between; align-items: center; }
    .t1-shortcut-panel h3 { margin: 0; font-size: 15px; color: var(--ui-fg); }
    .t1-shortcut-panel .close { background: transparent; border: none; color: var(--ui-muted); font-size: 18px; }
    .t1-shortcut-list { overflow-y: auto; padding: 10px 18px; }
    .t1-shortcut-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--ui-border); color: var(--ui-fg); font-size: 13px; }
    .t1-shortcut-row kbd { background: var(--ui-bg); padding: 2px 6px; border-radius: 4px; border: 1px solid var(--ui-border); font-family: inherit; }
  `);

  const overlay = document.createElement('div');
  overlay.className = 't1-shortcut-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Keyboard shortcuts');
  overlay.innerHTML = `
    <div class="t1-shortcut-panel">
      <header><h3>Keyboard Shortcuts</h3><button type="button" class="close" aria-label="Close shortcuts">✕</button></header>
      <div class="t1-shortcut-list"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const list = overlay.querySelector('.t1-shortcut-list');
  overlay.querySelector('.close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const COMMON = [
    { keys: 'Ctrl/Cmd + K', desc: 'Open command palette' },
    { keys: 'Ctrl/Cmd + Shift + P', desc: 'Open action palette' },
    { keys: 'Ctrl/Cmd + F', desc: 'Search scrollback' },
    { keys: 'Ctrl/Cmd + = / -', desc: 'Increase / decrease font size' },
    { keys: 'Ctrl + L', desc: 'Clear screen' },
    { keys: 'Ctrl + Z / Ctrl + Y', desc: 'Recall previous / next command' }
  ];
  const TOUCH = [
    { keys: 'Two-finger swipe', desc: 'Switch session tabs' },
    { keys: 'Two-finger tap', desc: 'Open terminal context menu' }
  ];

  function open() {
    const device = T1.device;
    list.innerHTML = '';
    const rows = [...COMMON, ...(device === 'desktop' ? [] : TOUCH)];
    for (const { keys, desc } of rows) {
      const row = document.createElement('div');
      row.className = 't1-shortcut-row';
      row.innerHTML = `<span>${desc}</span><kbd>${keys}</kbd>`;
      list.appendChild(row);
    }
    overlay.classList.add('open');
  }
  function close() { overlay.classList.remove('open'); }

  document.addEventListener('keydown', (e) => {
    if (e.key === '?' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); open(); }
    else if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) { e.preventDefault(); open(); }
    else if (e.key === 'Escape') { close(); }
  });

  window.__terminalOneShortcutHelp = { open, close, overlay };
}
