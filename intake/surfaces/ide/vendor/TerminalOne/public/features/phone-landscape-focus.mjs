/**
 * Chrome toggle + landscape focus (iPhone + iPad).
 *
 * Provides a persistent, always-on-screen floating toggle that collapses the
 * top header and bottom footer chrome to maximize terminal space. The on-screen
 * control bar (keybar) is NEVER hidden — it stays visible at the bottom on every
 * viewport size and orientation.
 *
 * The toggle is centered at the top and clamped inside the safe-area insets, so
 * a notch / Dynamic Island can never push it off-screen (the prior version used
 * `right: 12px`, which clipped off the right edge on notched devices in
 * landscape). It is a >=44pt touch target per Apple HIG.
 */
export function init(T1) {
  if (T1.device !== 'iphone' && T1.device !== 'ipad') return;

  T1.ui.addStyle(`
    /* Collapsed chrome hides header + footer + feature toolbar — but NEVER the
       keybar (control bar), which must stay visible at the bottom always. */
    body.t1-chrome-collapsed .terminal-header,
    body.t1-chrome-collapsed .terminal-footer,
    body.t1-chrome-collapsed .t1toolbar {
      display: none !important;
    }
    /* Always-on-screen chrome toggle. Centered + safe-area clamped so it can
       never sit off-screen or under a notch on any iPhone/iPad viewport. */
    .t1-chrome-fab {
      display: none;
      position: fixed;
      top: max(8px, env(safe-area-inset-top));
      left: 50%;
      transform: translateX(-50%);
      z-index: 350;
      min-width: 44px;
      min-height: 44px;
      padding: 8px 18px;
      font-size: 12px;
      line-height: 1;
      border-radius: 999px;
      background: var(--ui-elevated);
      border: 1px solid var(--ui-border);
      color: var(--ui-fg);
      box-shadow: 0 2px 10px rgba(0,0,0,0.35);
      opacity: 0.82;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }
    .t1-chrome-fab:active { opacity: 1; }
    body[data-device="iphone"] .t1-chrome-fab,
    body[data-device="ipad"] .t1-chrome-fab {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
  `);

  const fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 't1-chrome-fab';
  document.body.appendChild(fab);

  let collapsed = false;
  function render() {
    document.body.classList.toggle('t1-chrome-collapsed', collapsed);
    fab.textContent = collapsed ? 'Show bars' : 'Hide bars';
    fab.setAttribute(
      'aria-label',
      collapsed ? 'Show header and footer' : 'Hide header and footer for more terminal space'
    );
    fab.setAttribute('aria-pressed', String(collapsed));
  }
  function setCollapsed(v) {
    collapsed = !!v;
    render();
    T1.fit();
  }

  fab.addEventListener('click', () => setCollapsed(!collapsed));
  render();

  // Surface for automated tests + other features.
  window.__terminalOneChrome = {
    fab,
    isCollapsed: () => collapsed,
    setCollapsed,
    toggle: () => setCollapsed(!collapsed)
  };
}
