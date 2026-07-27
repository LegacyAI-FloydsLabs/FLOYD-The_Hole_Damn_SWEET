/**
 * Wake lock + fullscreen — keep the screen awake during long-running commands
 * and toggle fullscreen for more terminal space. Both APIs are optional on
 * mobile WebKit, so each control disables itself or toasts when unsupported.
 */
export function init(T1) {
  const tb = T1.ui.toolbar();
  if (!tb) return;

  // ── Screen Wake Lock ──
  let sentinel = null, wakeEnabled = false;

  const wake = T1.ui.makeButton('Wake', 'Keep screen awake', async () => {
    if (wakeEnabled) await disableWake();
    else await enableWake();
  });
  if (!('wakeLock' in navigator)) {
    wake.disabled = true;
    wake.title = 'Wake lock not supported';
  }

  async function acquire() {
    sentinel = await navigator.wakeLock.request('screen');
    wake.classList.add('active');
    sentinel.addEventListener('release', () => { wake.classList.remove('active'); });
  }
  async function enableWake() {
    try { await acquire(); wakeEnabled = true; }
    catch (_) { T1.toast('Could not acquire wake lock', 'warn'); }
  }
  async function disableWake() {
    wakeEnabled = false;
    wake.classList.remove('active');
    try { if (sentinel) await sentinel.release(); } catch (_) {}
    sentinel = null;
  }
  // Wake locks are auto-released when the tab is hidden; re-acquire on return.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && wakeEnabled && !sentinel) {
      try { await acquire(); } catch (_) {}
    }
  });

  // ── Fullscreen ──
  const fs = T1.ui.makeButton('Fullscreen', 'Toggle fullscreen', async () => {
    try {
      if (document.fullscreenElement) {
        if (document.exitFullscreen) await document.exitFullscreen();
      } else {
        const target = T1.ui.appShell() || document.documentElement;
        if (target.requestFullscreen) await target.requestFullscreen();
        else T1.toast('Fullscreen not supported', 'warn');
      }
    } catch (_) { T1.toast('Fullscreen blocked', 'warn'); }
  });
  const fsTarget = T1.ui.appShell() || document.documentElement;
  if (!fsTarget.requestFullscreen && !document.exitFullscreen) {
    fs.disabled = true;
    fs.title = 'Fullscreen not supported';
  }
  document.addEventListener('fullscreenchange', () => {
    fs.classList.toggle('active', !!document.fullscreenElement);
  });

  tb.appendChild(wake);
  tb.appendChild(fs);
}
