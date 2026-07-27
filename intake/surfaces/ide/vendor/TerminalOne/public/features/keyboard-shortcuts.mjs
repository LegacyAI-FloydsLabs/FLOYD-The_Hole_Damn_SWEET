/**
 * Global keyboard shortcuts — terminal-friendly chords that don't steal from
 * the shell. Each shortcut is gated so it only fires when xterm doesn't need
 * the key (i.e. target is document body, not the terminal textarea).
 */
const KEY = 'terminalone.shortcuts';

export function init(T1) {
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform || '');
  const meta = (e) => (isMac ? e.metaKey : e.ctrlKey);

  function dispatch(name) {
    window.dispatchEvent(new CustomEvent('t1:action', { detail: { action: name }, bubbles: true }));
  }

  document.addEventListener('keydown', (e) => {
    // Only intercept when focus is outside the terminal helper textarea,
    // unless the chord explicitly includes a modifier.
    const targetIsTerm = e.target && (e.target.classList?.contains('xterm-helper-textarea') ||
                                      e.target.closest?.('#terminal'));
    const mod = e.ctrlKey || e.metaKey || e.altKey || e.shiftKey;

    // Escape closes open modals/panels.
    if (e.key === 'Escape') {
      const openModal = document.querySelector('[role="dialog"].open, .t1help.open, .t1palette.open');
      if (openModal) { openModal.classList.remove('open'); e.preventDefault(); return; }
    }

    // F1 help.
    if (e.key === 'F1') { e.preventDefault(); dispatch('help'); return; }

    if (!mod) return; // plain typing belongs to the shell

    // Ctrl/Cmd + '+' / '-' font size.
    if ((e.key === '+' || e.key === '=' || e.key === 'Plus') && meta(e)) {
      e.preventDefault(); dispatch('font-increase'); return;
    }
    if ((e.key === '-' || e.key === '_' || e.key === 'Minus') && meta(e)) {
      e.preventDefault(); dispatch('font-decrease'); return;
    }

    // Ctrl/Cmd + K clear terminal screen.
    if ((e.key === 'k' || e.key === 'K') && meta(e)) {
      e.preventDefault(); dispatch('clear'); return;
    }

    // Ctrl/Cmd + Shift + P command palette.
    if ((e.key === 'p' || e.key === 'P') && meta(e) && e.shiftKey) {
      e.preventDefault(); dispatch('command-palette'); return;
    }

    // Ctrl/Cmd + B toggle snippets.
    if ((e.key === 'b' || e.key === 'B') && meta(e)) {
      e.preventDefault(); dispatch('toggle-snippets'); return;
    }

    // Ctrl/Cmd + Shift + F toggle search.
    if ((e.key === 'f' || e.key === 'F') && meta(e) && e.shiftKey) {
      e.preventDefault(); dispatch('toggle-search'); return;
    }
  }, true);

  // Listen to our own action events so this module is self-contained.
  window.addEventListener('t1:action', (e) => {
    const { action } = e.detail || {};
    if (action === 'clear' && T1.term) {
      T1.sendData('\x0c');
      T1.toast('Screen cleared');
    }
  });
}
