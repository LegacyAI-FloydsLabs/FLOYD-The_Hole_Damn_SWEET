/**
 * Desktop command palette shortcut Ctrl/Cmd+K.
 *
 * Registers a global keydown listener that opens the existing command palette
 * even when focus is outside the terminal.
 */
export function init(T1) {
  if (T1.device !== 'desktop') return;

  document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'k' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('t1:action', { detail: { action: 'command-palette' } }));
    }
  });

  window.__terminalOneDesktopPalette = { installed: true };
}
