/**
 * Status metrics — enhances the footer with latency (round-trip via a small
 * heartbeat), connection uptime, and an explicit shell indicator.
 *
 * ShellFish parity: detailed connection status and session metadata.
 */
export function init(T1) {
  const footerMeta = document.getElementById('footerMeta');
  const sessionInfo = document.getElementById('sessionInfo');
  if (!footerMeta || !sessionInfo) return;

  let connectedAt = 0;
  let rttMs = null;
  let currentCommand = '';
  let currentCwd = '';
  let lastFooterText = '';
  let ignoreNextMutation = false;

  function formatDuration(ms) {
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return `${h}h ${m}m`;
  }

  function updateFooter() {
    const parts = [];
    if (currentCommand) parts.push(currentCommand);
    if (currentCwd) parts.push(currentCwd);
    if (connectedAt) {
      parts.push(`up ${formatDuration(Date.now() - connectedAt)}`);
    }
    if (rttMs != null) {
      parts.push(`latency ${rttMs.toFixed(0)}ms`);
    }
    const text = parts.join(' · ') || 'WebSocket terminal emulator';
    if (text !== lastFooterText) {
      lastFooterText = text;
      ignoreNextMutation = true;
      footerMeta.textContent = text;
    }
  }

  // Track connection events from the global status text.
  const statusEl = document.getElementById('status');
  if (statusEl) {
    const observer = new MutationObserver(() => {
      const text = statusEl.textContent || '';
      if (text.includes('Connected') && !connectedAt) {
        connectedAt = Date.now();
      } else if (text.includes('Disconnected') || text.includes('Closed') || text.includes('Exited')) {
        connectedAt = 0;
        rttMs = null;
      }
      updateFooter();
    });
    observer.observe(statusEl, { childList: true, subtree: true });
  }

  // Update shell/cwd/command from the footer text set by the server.
  const footerObserver = new MutationObserver(() => {
    if (ignoreNextMutation) { ignoreNextMutation = false; return; }
    const text = footerMeta.textContent || '';
    const shellMatch = text.match(/^([\w\-.]+)\s*·\s*(.*)/);
    if (shellMatch) {
      currentCommand = shellMatch[1];
      currentCwd = shellMatch[2];
    } else {
      currentCwd = text;
    }
    updateFooter();
  });
  footerObserver.observe(footerMeta, { childList: true });

  // Lightweight latency probe: send a no-op ping every 10s when connected.
  let pingInFlight = false;
  setInterval(() => {
    if (pingInFlight) return;
    const ws = T1.ws || window.__terminalOne?.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const start = performance.now();
      pingInFlight = true;
      const handler = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === 'pong') {
            ws.removeEventListener('message', handler);
            clearTimeout(timeout);
            pingInFlight = false;
            rttMs = performance.now() - start;
            updateFooter();
          }
        } catch (_) {}
      };
      const timeout = setTimeout(() => {
        ws.removeEventListener('message', handler);
        pingInFlight = false;
      }, 5_000);
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 10_000);

  updateFooter();
}
