/**
 * Smart suggestion bar above the on-screen keyboard (iPhone only).
 *
 * Shows context-aware suggestions (sudo, git, cd, ls, clear) based on the
 * current input prefix and local command history. Tapping a suggestion
 * inserts it.
 */
const HISTORY_KEY = 'terminalone.commandHistory';
const DEFAULT_SUGGESTIONS = ['sudo', 'git', 'cd', 'ls', 'clear'];

export function init(T1) {
  if (T1.device !== 'iphone') return;

  T1.ui.addStyle(`
    .t1-smart-suggest {
      display: none;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      background: var(--ui-elevated);
      border-top: 1px solid var(--ui-border);
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    body[data-device="iphone"] .t1-smart-suggest { display: flex; }
    .t1-smart-suggest .sug {
      flex: 0 0 auto;
      padding: 6px 10px;
      font-size: 12px;
      color: var(--ui-fg);
      background: var(--ui-bg);
      border: 1px solid var(--ui-border);
      border-radius: 6px;
      cursor: pointer;
    }
    .t1-smart-suggest .sug:active { background: var(--ui-accent); color: #000; }
    .t1-smart-suggest .label {
      font-size: 10px;
      color: var(--ui-muted);
      margin-right: 2px;
      flex-shrink: 0;
    }
  `);

  const bar = document.createElement('div');
  bar.className = 't1-smart-suggest';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Smart suggestions');
  const keybar = document.getElementById('keybarIphone');
  if (keybar) keybar.parentNode.insertBefore(bar, keybar);

  function readHistory() {
    try { return JSON.parse(T1.storage.get(HISTORY_KEY, '[]')); }
    catch (_) { return []; }
  }

  function candidates(prefix) {
    const p = (prefix || '').toLowerCase();
    const hist = readHistory();
    const fromHistory = hist.slice().reverse().filter((c) => c && c.toLowerCase().startsWith(p) && !DEFAULT_SUGGESTIONS.includes(c));
    const fromDefaults = DEFAULT_SUGGESTIONS.filter((s) => s.startsWith(p));
    return Array.from(new Set([...fromDefaults, ...fromHistory])).slice(0, 8);
  }

  function render(prefix) {
    const list = candidates(prefix);
    bar.innerHTML = '';
    if (!list.length) {
      bar.style.display = 'none';
      return;
    }
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'SUGGEST:';
    bar.appendChild(label);
    for (const text of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sug';
      b.textContent = text;
      b.addEventListener('click', () => { T1.sendData(text); });
      bar.appendChild(b);
    }
    bar.style.display = 'flex';
  }

  function updateFromTerminal() {
    const term = T1.term;
    if (!term || !term.buffer) return;
    try {
      const row = term.buffer.active.getLine(term.buffer.active.cursorY);
      const text = (row ? row.translateToString(true) : '').trim();
      render(text);
    } catch (_) { bar.style.display = 'none'; }
  }

  let updateRaf = 0;
  function scheduleUpdate() {
    if (updateRaf) return;
    updateRaf = requestAnimationFrame(() => {
      updateRaf = 0;
      updateFromTerminal();
    });
  }

  T1.onTermReady((term) => {
    const dataDisposable = term.onData(scheduleUpdate);
    updateFromTerminal();
    return () => {
      if (updateRaf) {
        cancelAnimationFrame(updateRaf);
        updateRaf = 0;
      }
      dataDisposable.dispose();
    };
  });

  // Expose for tests.
  window.__terminalOneSmartSuggest = { bar, render, candidates };
}
