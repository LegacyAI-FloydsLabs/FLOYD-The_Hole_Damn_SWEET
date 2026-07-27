/**
 * Toast notifications and status bar — extends the built-in banner/toast with
 * a persistent log.  Clicking the status text opens a small panel showing the
 * last 20 system messages so users can review warnings they missed.
 */
const KEY = 'terminalone.statusLog';
const MAX = 20;

export function init(T1) {
  const originalToast = T1.toast;
  let log = [];

  function load() {
    try {
      const v = JSON.parse(T1.storage.get(KEY, '[]'));
      log = Array.isArray(v) ? v.slice(-MAX) : [];
    } catch (_) { log = []; }
  }
  function save() {
    T1.storage.set(KEY, JSON.stringify(log.slice(-MAX)));
  }
  function add(type, msg) {
    log.push({ t: Date.now(), type, msg });
    if (log.length > MAX) log.shift();
    save();
    updatePanel();
  }

  // Wrap the global toast so every toast is logged.
  T1.toast = function(msg, type = 'info') {
    add(type, msg);
    return originalToast.call(this, msg, type);
  };

  // Also log connection status changes.
  const statusEl = document.getElementById('status');
  if (statusEl) {
    const obs = new MutationObserver(() => {
      const text = statusEl.textContent;
      if (text && (text.includes('Disconnected') || text.includes('error') || text.includes('Exited'))) {
        add(text.includes('Disconnected') || text.includes('error') ? 'error' : 'warn', text);
      }
    });
    obs.observe(statusEl, { childList: true, subtree: true });
  }

  // Status panel attached to the footer.
  const footer = document.querySelector('.terminal-footer');
  if (!footer) return;

  T1.ui.addStyle(`
    .t1status-panel {
      position: absolute;
      bottom: 100%;
      right: 8px;
      z-index: 300;
      min-width: 240px;
      max-width: 80vw;
      max-height: 40vh;
      overflow-y: auto;
      background: var(--ui-elevated);
      border: 1px solid var(--ui-border);
      border-radius: 8px 8px 0 0;
      box-shadow: 0 -8px 32px rgba(0,0,0,0.35);
      display: none;
      flex-direction: column;
      padding: 8px;
    }
    .t1status-panel.open { display: flex; }
    .t1status-entry {
      font-size: 11px;
      padding: 4px 0;
      border-bottom: 1px solid var(--ui-border);
      color: var(--ui-fg);
    }
    .t1status-entry:last-child { border-bottom: none; }
    .t1status-entry.info { color: var(--ui-accent); }
    .t1status-entry.warn { color: #e0af68; }
    .t1status-entry.error { color: #f7768e; }
    .t1status-time { color: var(--ui-muted); margin-right: 6px; }
    .t1status-footer { color: var(--ui-muted); font-size: 11px; cursor: pointer; }
  `);

  const panel = document.createElement('div');
  panel.className = 't1status-panel';
  footer.appendChild(panel);

  const statusWrap = document.querySelector('.statuswrap');
  const clickTarget = statusWrap || footer;
  clickTarget.style.cursor = 'pointer';
  clickTarget.title = 'Click to view status log';
  clickTarget.addEventListener('click', () => panel.classList.toggle('open'));

  function updatePanel() {
    panel.innerHTML = '';
    if (!log.length) {
      const empty = document.createElement('div');
      empty.className = 't1status-entry';
      empty.textContent = 'No status messages yet';
      panel.appendChild(empty);
      return;
    }
    for (const entry of log.slice().reverse()) {
      const row = document.createElement('div');
      row.className = `t1status-entry ${entry.type || 'info'}`;
      const time = new Date(entry.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      row.innerHTML = `<span class="t1status-time">${time}</span>${entry.msg}`;
      panel.appendChild(row);
    }
  }

  load();
  updatePanel();

  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && !clickTarget.contains(e.target)) panel.classList.remove('open');
  });
}
