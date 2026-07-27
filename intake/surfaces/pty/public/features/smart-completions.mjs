/**
 * Smart command completions.
 *
 * As the user types, show inline command completions from history and shell
 * builtins. Tab accepts the top completion.
 */
const HISTORY_KEY = 'terminalone.commandHistory';
const BUILTINS = ['cd', 'ls', 'pwd', 'cat', 'echo', 'mkdir', 'rm', 'cp', 'mv', 'git', 'clear', 'exit', 'ssh', 'sudo', 'npm', 'node'];

export function init(T1) {
  if (T1.device === 'desktop') return;

  T1.ui.addStyle(`
    .t1-completion-hint {
      position: absolute;
      background: var(--ui-elevated);
      border: 1px solid var(--ui-border);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 12px;
      color: var(--ui-fg);
      z-index: 50;
      display: none;
      pointer-events: none;
    }
  `);

  const hint = document.createElement('div');
  hint.className = 't1-completion-hint';
  hint.setAttribute('role', 'status');
  hint.setAttribute('aria-live', 'polite');
  document.body.appendChild(hint);

  function readHistory() {
    try { return JSON.parse(T1.storage.get(HISTORY_KEY, '[]')); }
    catch (_) { return []; }
  }

  function candidates(prefix) {
    const p = (prefix || '').toLowerCase();
    if (!p) return [];
    const hist = readHistory().slice().reverse();
    const histMatches = hist.filter((c) => c && c.toLowerCase().startsWith(p) && c !== prefix);
    const builtinMatches = BUILTINS.filter((b) => b.startsWith(p) && b !== prefix);
    return Array.from(new Set([...builtinMatches, ...histMatches])).slice(0, 5);
  }

  let current = null;
  let currentTop = null;

  function update() {
    const term = T1.term;
    if (!term || !term.buffer) { hint.style.display = 'none'; return; }
    try {
      const row = term.buffer.active.getLine(term.buffer.active.cursorY);
      const text = (row ? row.translateToString(true) : '').trim();
      const list = candidates(text);
      if (!list.length) { hint.style.display = 'none'; current = null; currentTop = null; return; }
      currentTop = list[0];
      current = text;
      const rect = term.element.getBoundingClientRect();
      hint.textContent = list.join(', ');
      hint.style.display = 'block';
      hint.style.left = `${rect.left + 8}px`;
      hint.style.top = `${rect.bottom - 36}px`;
    } catch (_) { hint.style.display = 'none'; }
  }

  function accept() {
    if (!current || !currentTop) return;
    const suffix = currentTop.slice(current.length);
    if (suffix) T1.sendData(suffix + ' ');
  }

  let updateRaf = 0;
  function scheduleUpdate() {
    if (updateRaf) return;
    updateRaf = requestAnimationFrame(() => {
      updateRaf = 0;
      update();
    });
  }

  T1.onTermReady((term) => {
    const dataDisposable = term.onData(scheduleUpdate);
    const onKeyDown = (e) => {
      if (e.key === 'Tab') { e.preventDefault(); accept(); }
    };
    term.element.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      if (updateRaf) {
        cancelAnimationFrame(updateRaf);
        updateRaf = 0;
      }
      dataDisposable.dispose();
      term.element?.removeEventListener('keydown', onKeyDown, { capture: true });
    };
  });

  window.__terminalOneSmartCompletions = { candidates, accept, hint, update };
}
