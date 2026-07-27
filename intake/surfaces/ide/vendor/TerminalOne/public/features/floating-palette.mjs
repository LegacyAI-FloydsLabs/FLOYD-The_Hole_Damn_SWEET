/**
 * Floating command palette (tablet touch optimized).
 *
 * A large touch-target, bottom-sheet palette reachable from a floating
 * action button. Dispatches existing t1:action events so it reuses the
 * command-palette catalog.
 */
export function init(T1) {
  if (T1.device !== 'ipad') return;

  T1.ui.addStyle(`
    .t1-fab {
      position: fixed;
      right: 20px; bottom: calc(20px + env(safe-area-inset-bottom));
      width: 56px; height: 56px;
      border-radius: 50%;
      background: var(--ui-accent);
      color: #000;
      border: none;
      font-size: 24px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      z-index: 220;
      display: flex; align-items: center; justify-content: center;
    }
    .t1-tablet-sheet {
      position: fixed;
      left: 0; right: 0; bottom: 0;
      max-height: 60vh;
      background: var(--ui-elevated);
      border-radius: 16px 16px 0 0;
      border-top: 1px solid var(--ui-border);
      transform: translateY(110%);
      transition: transform 0.25s ease;
      z-index: 230;
      display: flex;
      flex-direction: column;
      padding-bottom: env(safe-area-inset-bottom);
    }
    .t1-tablet-sheet.open { transform: translateY(0); }
    .t1-tablet-sheet header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 18px; border-bottom: 1px solid var(--ui-border);
    }
    .t1-tablet-sheet h3 { margin: 0; font-size: 15px; color: var(--ui-fg); }
    .t1-tablet-sheet .sheet-close { background: transparent; border: none; color: var(--ui-muted); font-size: 18px; }
    .t1-tablet-actions { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; padding: 16px; overflow-y: auto; }
    .t1-tablet-actions button {
      min-height: 56px; padding: 10px;
      background: var(--ui-bg); color: var(--ui-fg);
      border: 1px solid var(--ui-border); border-radius: 10px;
      font-size: 14px; cursor: pointer;
    }
    .t1-tablet-actions button:active { background: var(--ui-accent); color: #000; }
  `);

  const fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 't1-fab';
  fab.textContent = '✦';
  fab.setAttribute('aria-label', 'Open command palette');
  document.body.appendChild(fab);

  const sheet = document.createElement('div');
  sheet.className = 't1-tablet-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Tablet command palette');
  sheet.innerHTML = `
    <header><h3>Command Palette</h3><button type="button" class="sheet-close" aria-label="Close palette">✕</button></header>
    <div class="t1-tablet-actions"></div>
  `;
  document.body.appendChild(sheet);

  const actionsEl = sheet.querySelector('.t1-tablet-actions');
  const ACTIONS = [
    { label: 'Search', action: 'search' },
    { label: 'Command Palette', action: 'command-palette' },
    { label: 'Clear', action: 'clear' },
    { label: 'Select All', action: 'select-all' },
    { label: 'Copy', action: 'copy' },
    { label: 'Paste', action: 'paste' },
    { label: 'Theme', action: 'theme' },
    { label: 'Font +', action: 'font-increase' },
    { label: 'Font -', action: 'font-decrease' }
  ];

  function open() {
    actionsEl.innerHTML = '';
    for (const { label, action } of ACTIONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('t1:action', { detail: { action } }));
        close();
      });
      actionsEl.appendChild(b);
    }
    sheet.classList.add('open');
  }
  function close() { sheet.classList.remove('open'); }

  fab.addEventListener('click', open);
  sheet.querySelector('.sheet-close').addEventListener('click', close);

  // Expose for tests.
  window.__terminalOneFloatingPalette = { open, close, fab, sheet, actionsEl };
}
