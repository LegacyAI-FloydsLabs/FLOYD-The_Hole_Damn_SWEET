/**
 * Two-finger tap context menu (tablet).
 *
 * A two-finger tap on the terminal opens a context menu with Copy, Paste,
 * Select All, Clear, and Search.
 */
export function init(T1) {
  if (T1.device !== 'ipad') return;

  T1.ui.addStyle(`
    .t1-twofinger-menu {
      position: fixed;
      background: var(--ui-elevated);
      border: 1px solid var(--ui-border);
      border-radius: 8px;
      padding: 4px 0;
      z-index: 210;
      display: none;
      min-width: 140px;
      box-shadow: 0 4px 14px rgba(0,0,0,0.3);
    }
    .t1-twofinger-menu button {
      display: block; width: 100%;
      padding: 8px 14px; background: transparent; border: none;
      color: var(--ui-fg); text-align: left; font-size: 13px; cursor: pointer;
    }
    .t1-twofinger-menu button:active { background: var(--ui-accent); color: #000; }
  `);

  const menu = document.createElement('div');
  menu.className = 't1-twofinger-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <button type="button" role="menuitem" data-action="copy">Copy</button>
    <button type="button" role="menuitem" data-action="paste">Paste</button>
    <button type="button" role="menuitem" data-action="select-all">Select All</button>
    <button type="button" role="menuitem" data-action="clear">Clear</button>
    <button type="button" role="menuitem" data-action="search">Search</button>
  `;
  document.body.appendChild(menu);

  let firstTouch = null;
  const target = T1.term?.element || document.querySelector('.terminal-container') || document.body;

  function hide() { menu.style.display = 'none'; }

  target.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      firstTouch = { x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
    } else { firstTouch = null; }
  }, { passive: true });

  target.addEventListener('touchend', (e) => {
    if (!firstTouch || e.touches.length > 0) return;
    e.preventDefault();
    menu.style.left = `${firstTouch.x}px`;
    menu.style.top = `${firstTouch.y}px`;
    menu.style.display = 'block';
    firstTouch = null;
  }, { passive: false });

  menu.addEventListener('click', (e) => {
    const action = e.target.dataset.action;
    if (!action) return;
    hide();
    const term = T1.term;
    if (action === 'copy') document.execCommand('copy');
    if (action === 'paste') document.execCommand('paste');
    if (action === 'select-all' && term) term.selectAll();
    if (action === 'clear' && term) term.clear();
    if (action === 'search') window.dispatchEvent(new CustomEvent('t1:action', { detail: { action: 'search' } }));
  });

  window.__terminalOneTwoFingerMenu = { menu, hide };
}
