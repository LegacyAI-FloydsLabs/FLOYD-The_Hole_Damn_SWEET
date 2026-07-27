/**
 * Window title reflects shell cwd.
 *
 * The server sends cwd via the ready/footer metadata. We update document.title
 * to "TerminalOne — ~/path" whenever it changes.
 */
export function init(T1) {
  function basename(path) {
    if (!path) return '';
    // Normalize to a user-friendly tilde path if under $HOME.
    const home = (typeof process !== 'undefined' && process.env?.HOME) || '';
    let p = path.replace(/\/$/, '') || '/';
    if (home && p.startsWith(home)) p = '~' + p.slice(home.length);
    // Strip the trailing segment from the footer text if it includes command info.
    return p.split('/').pop() || p;
  }

  function parseCwd(text) {
    if (!text) return null;
    // Footer formats: "command · cwd" or "Resumed · cwd" or "Process exited · ..."
    const parts = text.split('·').map((s) => s.trim());
    if (parts.length >= 2 && !text.includes('exited')) return parts[parts.length - 1];
    return null;
  }

  function update() {
    const footer = document.getElementById('footerMeta')?.textContent || '';
    const cwd = parseCwd(footer);
    if (cwd) document.title = `TerminalOne — ${basename(cwd)}`;
  }

  const footerEl = document.getElementById('footerMeta');
  if (footerEl) {
    const mo = new MutationObserver(update);
    mo.observe(footerEl, { childList: true });
  }
  update();

  window.__terminalOneWindowTitle = { update, parseCwd, basename };
}
