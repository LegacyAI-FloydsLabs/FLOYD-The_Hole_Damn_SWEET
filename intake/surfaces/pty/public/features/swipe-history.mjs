/**
 * Swipe-up command history tray (phone vertical).
 *
 * On iPhone, swiping up from the bottom key bar opens a drawer showing the
 * most recent commands from the local history ring. Tapping a command pastes
 * it into the terminal input.
 */
const HISTORY_KEY = 'terminalone.commandHistory';

export function init(T1) {
  if (T1.device !== 'iphone') return;

  T1.ui.addStyle(`
    .t1-swipe-history-tray {
      position: fixed;
      left: 0; right: 0; bottom: 0;
      max-height: 45vh;
      background: var(--ui-elevated);
      border-top: 1px solid var(--ui-border);
      border-radius: 12px 12px 0 0;
      transform: translateY(110%);
      transition: transform 0.25s ease;
      z-index: 250;
      display: flex;
      flex-direction: column;
      padding-bottom: env(safe-area-inset-bottom);
    }
    .t1-swipe-history-tray.open { transform: translateY(0); }
    .t1-swipe-history-tray header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border-bottom: 1px solid var(--ui-border);
    }
    .t1-swipe-history-tray h3 { margin: 0; font-size: 13px; color: var(--ui-fg); }
    .t1-swipe-history-tray .close-btn {
      background: transparent; border: none; color: var(--ui-muted); font-size: 16px;
    }
    .t1-swipe-history-list {
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
    }
    .t1-swipe-history-list .cmd {
      padding: 12px 14px;
      border-bottom: 1px solid var(--ui-border);
      font-size: 13px;
      color: var(--ui-fg);
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .t1-swipe-history-list .cmd:active { background: var(--ui-accent); color: #000; }
    .t1-swipe-history-list .empty {
      padding: 20px 14px; color: var(--ui-muted); font-size: 12px; text-align: center;
    }
    .t1-swipe-history-hint {
      position: fixed;
      left: 50%; bottom: 4px;
      transform: translateX(-50%);
      width: 36px; height: 4px;
      border-radius: 2px;
      background: var(--ui-border);
      z-index: 251;
      pointer-events: none;
    }
  `);

  const tray = document.createElement('div');
  tray.className = 't1-swipe-history-tray';
  tray.setAttribute('role', 'dialog');
  tray.setAttribute('aria-label', 'Command history');
  tray.innerHTML = `
    <header><h3>Recent commands</h3><button type="button" class="close-btn" aria-label="Close history">Close</button></header>
    <div class="t1-swipe-history-list"></div>
  `;
  document.body.appendChild(tray);

  const hint = document.createElement('div');
  hint.className = 't1-swipe-history-hint';
  document.body.appendChild(hint);

  const list = tray.querySelector('.t1-swipe-history-list');
  tray.querySelector('.close-btn').addEventListener('click', close);

  function readHistory() {
    try { return JSON.parse(T1.storage.get(HISTORY_KEY, '[]')); }
    catch (_) { return []; }
  }

  function render() {
    const hist = readHistory().slice().reverse();
    list.innerHTML = '';
    if (!hist.length) {
      list.innerHTML = '<div class="empty">No commands yet. Type something and press Enter.</div>';
      return;
    }
    for (const cmd of hist) {
      const row = document.createElement('div');
      row.className = 'cmd';
      row.textContent = cmd;
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.addEventListener('click', () => { T1.sendData(cmd); close(); T1.toast('Pasted from history'); });
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); row.click(); } });
      list.appendChild(row);
    }
  }

  function open() { render(); tray.classList.add('open'); }
  function close() { tray.classList.remove('open'); }

  // Swipe up from the bottom key bar opens the tray.
  const keybar = document.getElementById('keybarIphone');
  if (keybar) {
    let startY = 0;
    let startX = 0;
    keybar.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      startY = t.clientY;
      startX = t.clientX;
    }, { passive: true });
    keybar.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0];
      const dy = startY - t.clientY;
      const dx = Math.abs(startX - t.clientX);
      if (dy > 40 && dx < 60) {
        e.preventDefault();
        open();
      }
    }, { passive: false });
  }

  // Clicking the hint also opens it for discoverability.
  hint.addEventListener('click', open);

  // Test hook.
  window.__terminalOneSwipeHistory = { open, close, tray, render, readHistory };
}
