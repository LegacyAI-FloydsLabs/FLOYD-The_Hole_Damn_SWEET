/**
 * Cross-device settings export/import cloud hook (local-first).
 *
 * Extends the settings import/export with a sync token / QR code for easy
 * transfer. Settings are exported as JSON; import validates schema version.
 */
const SCHEMA_VERSION = 2;
const LS_SYNC_TOKEN = 'terminalone.syncToken';

export function init(T1) {
  T1.ui.addStyle(`
    .t1-sync-token { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 13px; word-break: break-all; }
    .t1-qr-host { display: inline-block; padding: 6px; background: #fff; border-radius: 4px; }
  `);

  function collectSettings() {
    const out = {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      theme: T1.storage.get('terminalone.theme', 'tokyo-night'),
      style: T1.storage.get('terminalone.style', 'default'),
      cursorStyle: T1.storage.get('terminalone.cursorStyle', 'block'),
      cursorBlink: T1.storage.get('terminalone.cursorBlink', 'true') === 'true',
      bell: T1.storage.get('terminalone.bell', 'false') === 'true',
      scrollback: parseInt(T1.storage.get('terminalone.scrollback', '10000'), 10),
      fontSize: parseInt(T1.storage.get('terminalone.fontSize', '14'), 10)
    };
    // Appearance studio settings (feature: appearance.mjs). Background images
    // are excluded from export: data URLs bloat the payload beyond QR range.
    const appearance = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('terminalone.appearance.') && k !== 'terminalone.appearance.bgImage') {
          appearance[k.slice('terminalone.appearance.'.length)] = localStorage.getItem(k);
        }
      }
    } catch (_) {}
    if (Object.keys(appearance).length) out.appearance = appearance;
    return out;
  }

  function validate(data) {
    if (!data || typeof data !== 'object') return { ok: false, reason: 'not an object' };
    if (typeof data.schemaVersion !== 'number') return { ok: false, reason: 'missing schemaVersion' };
    if (data.schemaVersion > SCHEMA_VERSION) return { ok: false, reason: `schemaVersion ${data.schemaVersion} > supported ${SCHEMA_VERSION}` };
    if (data.theme && typeof data.theme !== 'string') return { ok: false, reason: 'invalid theme' };
    return { ok: true };
  }

  function importSettings(data) {
    const v = validate(data);
    if (!v.ok) throw new Error(v.reason);
    if (data.theme) T1.storage.set('terminalone.theme', data.theme);
    if (data.style) T1.storage.set('terminalone.style', data.style);
    if (data.cursorStyle) T1.storage.set('terminalone.cursorStyle', data.cursorStyle);
    if (typeof data.cursorBlink === 'boolean') T1.storage.set('terminalone.cursorBlink', String(data.cursorBlink));
    if (typeof data.bell === 'boolean') T1.storage.set('terminalone.bell', String(data.bell));
    if (data.scrollback) T1.storage.set('terminalone.scrollback', String(data.scrollback));
    if (data.fontSize) T1.storage.set('terminalone.fontSize', String(data.fontSize));
    if (data.appearance && typeof data.appearance === 'object') {
      for (const [k, v] of Object.entries(data.appearance)) {
        if (/^[\w-]{1,40}$/.test(k) && typeof v === 'string' && v.length <= 500) {
          T1.storage.set(`terminalone.appearance.${k}`, v);
        }
      }
    }
    return true;
  }

  function generateToken() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let token = '';
    for (let i = 0; i < 12; i++) token += chars.charAt(Math.floor(Math.random() * chars.length));
    T1.storage.set(LS_SYNC_TOKEN, token);
    return token;
  }

  function getToken() { return T1.storage.get(LS_SYNC_TOKEN, '') || generateToken(); }

  // Toolbar button: export with token.
  const exportBtn = T1.ui.makeButton('Sync', 'Export settings with sync token', () => {
    const payload = collectSettings();
    payload.syncToken = getToken();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `terminalone-sync-${payload.syncToken}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    T1.toast(`Settings exported (token ${payload.syncToken})`);
  });
  T1.ui.toolbar().appendChild(exportBtn);

  // Expose for tests.
  window.__terminalOneSettingsSync = { collectSettings, importSettings, validate, generateToken, getToken, SCHEMA_VERSION };
}
