/**
 * Haptic feedback for on-screen keys (phone/tablet).
 *
 * Uses navigator.vibrate when available, falling back to the iOS haptic API
 * if present. Only fires on genuine touch events, not mouse clicks.
 */
export function init(T1) {
  if (T1.device === 'desktop') return;

  const hasVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  const haptic = typeof window !== 'undefined' && window.navigator && typeof window.navigator.vibrate === 'function'
    ? window.navigator.vibrate.bind(window.navigator)
    : null;

  function fire(ev) {
    // Only on real touch paths (not mouse/keyboard).
    if (ev?.sourceCapabilities?.firesTouchEvents === false) return;
    if (hasVibrate) {
      try { navigator.vibrate(10); } catch (_) {}
    } else if (typeof window !== 'undefined' && window.webkit?.messageHandlers?.haptic) {
      try { window.webkit.messageHandlers.haptic.postMessage('light'); } catch (_) {}
    }
  }

  function wire(key) {
    key.addEventListener('touchstart', fire, { passive: true });
  }

  function scan() {
    document.querySelectorAll('#keybarIphone .kb-key, #keybarIpad .kb-key').forEach(wire);
  }

  // Initial scan plus observer for dynamic rebuilds.
  scan();
  const mo = new MutationObserver(scan);
  for (const id of ['keybarIphone', 'keybarIpad']) {
    const el = document.getElementById(id);
    if (el) mo.observe(el, { childList: true, subtree: true });
  }

  window.__terminalOneHaptic = { fire, wired: scan };
}
