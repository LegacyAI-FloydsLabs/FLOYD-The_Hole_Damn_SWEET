/**
 * Autosave — periodically snapshot the terminal scrollback to localStorage
 * so a page reload (or crash) can restore the last N lines.  Saved every 10s
 * and on disconnect, capped at 2000 lines to keep storage healthy.
 */
const KEY = 'terminalone.autosave';
const MAX_LINES = 2000;
const INTERVAL_MS = 10_000;

export function init(T1) {
  let timer = 0;

  function snapshot() {
    const term = T1.term;
    if (!term || !term.buffer) return;
    try {
      const buf = term.buffer.active;
      const lines = [];
      for (let i = buf.length - MAX_LINES; i < buf.length; i += 1) {
        if (i < 0) continue;
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      const payload = {
        ts: Date.now(),
        lines: lines.slice(-MAX_LINES),
        theme: document.body.dataset.theme,
        style: document.body.dataset.style
      };
      T1.storage.set(KEY, JSON.stringify(payload));
    } catch (_) {}
  }

  function restore() {
    try {
      const raw = T1.storage.get(KEY, null);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.lines) || !data.lines.length) return false;
      const term = T1.term;
      if (term && data.lines.length) {
        term.write(`\r\n\x1b[2m[autosave restored — ${data.lines.length} lines]\x1b[0m\r\n`);
        term.write(data.lines.join('\r\n') + '\r\n');
        if (data.theme && window.__terminalOne) window.__terminalOne.setTheme(data.theme);
        if (data.style && window.__terminalOne) window.__terminalOne.setStyle(data.style);
      }
      T1.toast(`Restored ${data.lines.length} autosaved lines`);
      return true;
    } catch (_) { return false; }
  }

  T1.onTermReady(() => {
    clearInterval(timer);
    timer = setInterval(snapshot, INTERVAL_MS);
    // Save immediately on connect to capture the resumed buffer.
    snapshot();
  });

  window.addEventListener('beforeunload', snapshot);

  // Restore on first connect if there is saved data and no active session resumed.
  let restored = false;
  const checkRestore = () => {
    if (restored) return;
    restored = true;
    // Wait a moment to see if the server sends a resumed session.
    setTimeout(() => {
      const footer = document.getElementById('footerMeta')?.textContent || '';
      if (!footer.includes('Resumed')) restore();
    }, 400);
  };
  T1.onTermReady(() => checkRestore());

  // Manual autosave action.
  window.addEventListener('t1:action', (e) => {
    if ((e.detail || {}).action === 'autosave-now') snapshot();
  });
}
