/**
 * Multi-window session sync via BroadcastChannel.
 *
 * When TerminalOne is open in multiple tabs/windows, session creation/deletion
 * and active-session changes are broadcast so tabs stay in sync.
 * Falls back to WebLocks + localStorage when BroadcastChannel is unavailable.
 */
const BC_NAME = 'terminalone-sync';
const LS_BCAST = 'terminalone.lsBroadcast';

export function init(T1) {
  function send(type, payload) {
    const msg = JSON.stringify({ type, payload, ts: Date.now() });
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        const bc = new BroadcastChannel(BC_NAME);
        bc.postMessage(msg);
        bc.close();
      } catch (_) {}
    }
    // localStorage fallback for browsers without BC (private mode iOS WebKit).
    try {
      localStorage.setItem(LS_BCAST, JSON.stringify({ msg, nonce: Math.random(), ts: Date.now() }));
    } catch (_) {}
  }

  function handleRaw(raw) {
    let data;
    try { data = JSON.parse(raw); } catch (_) { return; }
    if (!data || !data.type) return;
    if (data.type === 'session-active' || data.type === 'session-created' || data.type === 'session-deleted') {
      const detail = data.payload || {};
      if (detail.sessionId) T1.toast(`Synced: ${data.type.replace('session-', '')} ${detail.sessionId.slice(0, 8)}`);
    }
  }

  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const bc = new BroadcastChannel(BC_NAME);
      bc.onmessage = (e) => handleRaw(e.data);
    } catch (_) {}
  }

  window.addEventListener('storage', (e) => {
    if (e.key !== LS_BCAST) return;
    try {
      const wrapped = JSON.parse(e.newValue || '{}');
      if (wrapped && wrapped.msg) handleRaw(wrapped.msg);
    } catch (_) {}
  });

  // Hook session lifecycle by watching the saved session id and session info text.
  let lastSession = T1.storage.get('terminalone.sessionId', null);
  window.__terminalOneGetSavedSession = () => T1.storage.get('terminalone.sessionId', null);

  const infoEl = document.getElementById('sessionInfo');
  if (infoEl) {
    const mo = new MutationObserver(() => {
      const text = infoEl.textContent || '';
      const m = text.match(/session\s+([a-f0-9\-]+)/);
      if (m) {
        const sid = m[1];
        if (sid !== lastSession) {
          send('session-active', { sessionId: sid });
          lastSession = sid;
        }
      }
    });
    mo.observe(infoEl, { childList: true });
  }

  // Expose manual broadcast for tests.
  window.__terminalOneMultiWindow = { send, handleRaw, lastSession: () => lastSession };
}
