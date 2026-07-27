/**
 * Background heartbeat / mobile keepalive.
 *
 * When the page becomes hidden (mobile app switch, desktop tab background),
 * send a periodic WebSocket ping/heartbeat so the server keeps the session
 * alive longer.
 */
export function init(T1) {
  let hiddenTimer = null;
  const INTERVAL_MS = 15_000;

  function isHidden() {
    return typeof document !== 'undefined' && document.hidden;
  }

  function beat() {
    const sock = T1.ws;
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    try { sock.send(JSON.stringify({ type: 'ping', ts: Date.now() })); } catch (_) {}
  }

  function onVisibility() {
    if (isHidden()) {
      if (hiddenTimer) return;
      beat();
      hiddenTimer = setInterval(beat, INTERVAL_MS);
    } else {
      if (hiddenTimer) { clearInterval(hiddenTimer); hiddenTimer = null; }
    }
  }

  document.addEventListener('visibilitychange', onVisibility);
  if (isHidden()) onVisibility();

  window.__terminalOneKeepalive = { beat, isHidden, intervalMs: INTERVAL_MS };
}
