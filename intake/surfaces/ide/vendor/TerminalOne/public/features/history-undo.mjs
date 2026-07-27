/**
 * Undo/Redo system — local command history.
 *
 * Every time the user submits a line (Enter) we snapshot the command text
 * accumulated in the current line into a local history ring.  The user can
 * then Ctrl+Z to recall the previous command into the prompt and Ctrl+Y to
 * cycle forward, independent of the shell's own history.  This gives an
 * undo/redo feel for "what I just typed" across disconnects and fresh shells.
 */
const KEY = 'terminalone.commandHistory';
const MAX = 50;

export function init(T1) {
  let history = [];
  let index = -1; // -1 means current blank line
  let pending = '';

  function load() {
    try {
      const v = JSON.parse(T1.storage.get(KEY, '[]'));
      history = Array.isArray(v) ? v.slice(-MAX) : [];
    } catch (_) { history = []; }
  }
  function save() {
    T1.storage.set(KEY, JSON.stringify(history.slice(-MAX)));
  }

  function recall(dir) {
    if (!history.length) return;
    if (index === -1) pending = ''; // remember empty current line
    index += dir;
    if (index < -1) index = history.length - 1;
    if (index >= history.length) index = -1;

    const cmd = index === -1 ? pending : history[index];
    if (!cmd) return;

    // Send Ctrl+U to clear the current line, then the recalled command.
    T1.sendData('\x15');
    setTimeout(() => T1.sendData(cmd), 10);
    T1.toast(index === -1 ? 'Restored blank line' : `History ${index + 1}/${history.length}`);
  }

  function remember(cmd) {
    if (!cmd || cmd.trim().length === 0) return;
    if (history[history.length - 1] === cmd) return;
    history.push(cmd);
    if (history.length > MAX) history.shift();
    save();
    index = -1;
    pending = '';
  }

  load();

  // Heuristic line capture: when Enter is sent, read the terminal's current
  // buffer line from xterm's active row.  xterm exposes buffer.active.
  window.addEventListener('t1:action', (e) => {
    const { action } = e.detail || {};
    if (action === 'history-back') { recall(-1); return; }
    if (action === 'history-forward') { recall(1); return; }
    if (action === 'clear') { index = -1; pending = ''; }
  });

  // Hook Enter presses to snapshot the typed line.
  T1.onTermReady((term) => {
    let captureTimer = 0;
    const dataDisposable = term.onData((data) => {
      if (data === '\r') {
        // xterm does not expose a synchronous "current line"; wait a tick
        // so the shell echo has landed, then read the active row.
        if (captureTimer) clearTimeout(captureTimer);
        captureTimer = setTimeout(() => {
          captureTimer = 0;
          try {
            const row = term.buffer.active.getLine(term.buffer.active.cursorY);
            const text = row ? row.translateToString(true) : '';
            // Strip the prompt portion is impossible generically; store raw.
            remember(text.trim());
          } catch (_) {}
        }, 50);
      }
    });
    return () => {
      if (captureTimer) clearTimeout(captureTimer);
      dataDisposable.dispose();
    };
  });

  // Global shortcuts: Ctrl+Z undo (back), Ctrl+Y redo (forward), Ctrl+Shift+Z also forward.
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key === 'z' || e.key === 'Z') {
      if (e.shiftKey) { e.preventDefault(); recall(1); }
      else { e.preventDefault(); recall(-1); }
    } else if (e.key === 'y' || e.key === 'Y') {
      e.preventDefault();
      recall(1);
    }
  });
}
