/**
 * Recent items — quick palette of the last commands typed in this terminal.
 * Persists in localStorage and integrates with the command history collected by
 * the undo/redo feature.  Adds a "Recent" toolbar button that opens a dropdown.
 */
const HISTORY_KEY = 'terminalone.commandHistory';
const MAX = 15;

export function init(T1) {
  const tb = T1.ui.toolbar();
  if (!tb) return;

  T1.ui.addStyle(`
    .t1recent-pop {
      position: absolute;
      top: 100%;
      right: 8px;
      z-index: 350;
      min-width: 220px;
      max-width: 80vw;
      max-height: 60vh;
      overflow-y: auto;
      background: var(--ui-elevated);
      border: 1px solid var(--ui-border);
      border-radius: 8px;
      box-shadow: 0 -8px 32px rgba(0,0,0,0.35);
      display: none;
      flex-direction: column;
      padding: 6px;
    }
    .t1recent-pop.open { display: flex; }
    .t1recent-item {
      text-align: left;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 3px;
    }
    .t1recent-empty { padding: 8px; color: var(--ui-muted); font-size: 12px; }
  `);

  const pop = document.createElement('div');
  pop.className = 't1recent-pop';
  // Position the menu from the toolbar. The full-height application shell made
  // `bottom: 100%` place the entire menu above the visible viewport.
  tb.style.position = 'relative';
  tb.appendChild(pop);

  function readHistory() {
    try {
      const v = JSON.parse(T1.storage.get(HISTORY_KEY, '[]'));
      return Array.isArray(v) ? v.slice(-MAX).reverse() : [];
    } catch (_) { return []; }
  }

  function render() {
    const list = readHistory();
    pop.innerHTML = '';
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 't1recent-empty';
      empty.textContent = 'No recent commands yet';
      pop.appendChild(empty);
      return;
    }
    for (const cmd of list) {
      const b = T1.ui.makeButton(cmd, `Insert: ${cmd}`, () => {
        T1.sendData(cmd);
        pop.classList.remove('open');
      });
      b.classList.add('t1recent-item');
      pop.appendChild(b);
    }
  }

  const toggle = T1.ui.makeButton('Recent', 'Recent commands', () => {
    render();
    pop.classList.toggle('open');
  });
  tb.appendChild(toggle);

  // Close when clicking outside.
  document.addEventListener('click', (e) => {
    if (!pop.contains(e.target) && e.target !== toggle) pop.classList.remove('open');
  });

  // Keyboard shortcut Ctrl/Cmd+Shift+R opens recent palette.
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault();
      render();
      pop.classList.toggle('open');
    }
  });

  // React to new history being written by autosaving history elsewhere.
  let lastKnown = JSON.stringify(readHistory());
  setInterval(() => {
    const cur = JSON.stringify(readHistory());
    if (cur !== lastKnown && pop.classList.contains('open')) { lastKnown = cur; render(); }
  }, 2000);
}
