/**
 * Swipe-left/right session switcher.
 *
 * Two-finger horizontal swipe or edge swipe switches to next/previous
 * session tab. Wraps around at the ends. Works on phones and tablets.
 */
export function init(T1) {
  if (T1.device === 'desktop') return;

  let startX = 0;
  let startY = 0;
  let isTwoFinger = false;
  const EDGE_PX = 28;

  function getTabs() {
    return Array.from(document.querySelectorAll('.t1session-tab')).filter((t) => !t.classList.contains('t1session-new'));
  }

  function getActiveIndex(tabs) {
    return tabs.findIndex((t) => t.classList.contains('active'));
  }

  function switchTo(tabs, idx) {
    if (!tabs.length || idx < 0 || idx >= tabs.length) return;
    tabs[idx].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    T1.toast(`Switched to ${tabs[idx].textContent.trim()}`);
  }

  function next() {
    const tabs = getTabs();
    let i = getActiveIndex(tabs);
    if (i < 0) i = 0;
    switchTo(tabs, (i + 1) % tabs.length);
  }

  function prev() {
    const tabs = getTabs();
    let i = getActiveIndex(tabs);
    if (i < 0) i = 0;
    switchTo(tabs, (i - 1 + tabs.length) % tabs.length);
  }

  const target = T1.term?.element || document.querySelector('.terminal-container') || document.body;

  target.addEventListener('touchstart', (e) => {
    if (e.touches.length >= 2) {
      isTwoFinger = true;
      startX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      startY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      return;
    }
    isTwoFinger = false;
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
  }, { passive: true });

  target.addEventListener('touchend', (e) => {
    if (!startX && !startY) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = Math.abs(t.clientY - startY);
    const minDX = 70;
    const maxDY = 80;

    if (dy > maxDY) { startX = 0; startY = 0; return; }

    if (isTwoFinger) {
      if (dx > minDX) { e.preventDefault(); prev(); }
      else if (dx < -minDX) { e.preventDefault(); next(); }
      isTwoFinger = false;
    } else {
      const isEdge = startX <= EDGE_PX || startX >= window.innerWidth - EDGE_PX;
      if (isEdge && Math.abs(dx) > minDX) {
        e.preventDefault();
        if (dx > 0) prev(); else next();
      }
    }
    startX = 0;
    startY = 0;
  }, { passive: false });

  // Expose for tests.
  window.__terminalOneSwipeSessions = { next, prev, getTabs };
}
