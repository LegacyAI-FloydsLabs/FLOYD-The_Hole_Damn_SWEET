/**
 * Theme system preference detection — on the first visit with no manually
 * stored theme, follow the OS `prefers-color-scheme` setting. Once the user
 * explicitly picks a theme in Settings we stop syncing so their choice sticks.
 */
const LS_THEME = 'terminalone.theme';
const LS_THEME_USER_SET = 'terminalone.themeUserSet';

export function init(T1) {
  const darkMq = window.matchMedia('(prefers-color-scheme: dark)');

  function hasStoredTheme() {
    try { return localStorage.getItem(LS_THEME) !== null; } catch (_) { return false; }
  }
  function userHasSetTheme() {
    try { return localStorage.getItem(LS_THEME_USER_SET) === '1'; } catch (_) { return false; }
  }
  function setUserSetTheme() {
    try { localStorage.setItem(LS_THEME_USER_SET, '1'); } catch (_) {}
  }

  // If the user has never picked a theme, seed from system preference.
  if (!hasStoredTheme() && !userHasSetTheme()) {
    const systemDark = darkMq.matches;
    const initialTheme = systemDark ? 'tokyo-night' : 'solarized-light';
    if (window.__terminalOne && typeof window.__terminalOne.setTheme === 'function') {
      window.__terminalOne.setTheme(initialTheme);
    } else if (T1.ui && T1.ui.settingsPanel) {
      const sel = document.getElementById('themeSelect');
      if (sel) { sel.value = initialTheme; sel.dispatchEvent(new Event('change')); }
    }
  }

  // Listen to OS changes and sync only while the user has not manually chosen.
  const onSchemeChange = () => {
    if (userHasSetTheme()) return;
    const theme = darkMq.matches ? 'tokyo-night' : 'solarized-light';
    if (window.__terminalOne && typeof window.__terminalOne.setTheme === 'function') {
      window.__terminalOne.setTheme(theme);
    }
  };
  try { darkMq.addEventListener('change', onSchemeChange); } catch (_) {
    try { darkMq.addListener(onSchemeChange); } catch (_) {}
  }

  // Mark a manual theme pick so system changes stop overriding it.
  const themeSelect = document.getElementById('themeSelect');
  if (themeSelect) {
    themeSelect.addEventListener('change', () => setUserSetTheme(), { once: true });
  }
}
