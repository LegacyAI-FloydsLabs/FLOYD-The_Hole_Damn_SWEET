/**
 * Zoom / pinch-to-zoom font size for TerminalOne.
 *
 * ShellFish parity: pinch to zoom the terminal text.
 */
const LS_ZOOM = 'terminalone.fontSize';

export function init(T1) {
  let current = parseInt(T1.storage.get(LS_ZOOM, '14'), 10) || 14;

  function apply(size) {
    current = Math.max(8, Math.min(32, size));
    const term = T1.term;
    if (term) {
      term.options.fontSize = current;
      T1.fit();
    }
    T1.storage.set(LS_ZOOM, String(current));
  }

  // Listen to keyboard-shortcuts action events.
  window.addEventListener('t1:action', (e) => {
    const { action } = e.detail || {};
    if (action === 'font-increase') { apply(current + 1); T1.toast(`Font size ${current}px`); }
    if (action === 'font-decrease') { apply(current - 1); T1.toast(`Font size ${current}px`); }
    if (action === 'font-reset') { apply(14); T1.toast('Font size reset'); }
  });

  // Pinch-to-zoom on the terminal element.
  T1.onTermReady((term) => {
    const el = term.element;
    if (!el) return;
    let startDist = 0;
    let startSize = current;
    function onTouchStart(e) {
      if (e.touches.length === 2) {
        startDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        startSize = current;
      }
    }
    function onTouchMove(e) {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        const ratio = dist / (startDist || 1);
        apply(Math.round(startSize * ratio));
      }
    }
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
    };
  });

  // Make sure the initial persisted zoom is applied after term is ready.
  T1.onTermReady(() => apply(current));
}
