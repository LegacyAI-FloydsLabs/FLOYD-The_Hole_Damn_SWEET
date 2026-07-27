/**
 * Biometric / PIN session lock.
 *
 * Optional per-session lock. Uses WebAuthn / Credential Management on desktop
 * where available; falls back to a simple PIN modal on phone/tablet.
 * Locks the terminal with a blur overlay until authenticated.
 */
const LS_PIN = 'terminalone.sessionPin';
const LS_LOCKED = 'terminalone.sessionLocked';

export function init(T1) {
  T1.ui.addStyle(`
    .t1-lock-overlay {
      position: fixed; inset: 0;
      backdrop-filter: blur(12px);
      background: rgba(0,0,0,0.55);
      z-index: 600;
      display: none; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
    }
    .t1-lock-overlay.active { display: flex; }
    .t1-lock-overlay h3 { color: #fff; margin: 0; font-size: 16px; }
    .t1-lock-overlay input {
      width: 180px; padding: 10px; font-size: 16px; text-align: center;
      border-radius: 6px; border: 1px solid var(--ui-border); background: var(--ui-bg); color: var(--ui-fg);
    }
    .t1-lock-overlay button {
      padding: 8px 18px; border-radius: 6px; border: none;
      background: var(--ui-accent); color: #000; cursor: pointer; font-weight: 600;
    }
    .t1-lock-overlay .hint { color: #aaa; font-size: 12px; }
  `);

  const overlay = document.createElement('div');
  overlay.className = 't1-lock-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Unlock session');
  overlay.innerHTML = `
    <h3>Session locked</h3>
    <input type="password" maxlength="8" inputmode="numeric" placeholder="PIN" aria-label="PIN" />
    <button type="button">Unlock</button>
    <span class="hint">Set a PIN in settings to protect this session.</span>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('input');
  const btn = overlay.querySelector('button');

  function setPin(pin) { T1.storage.set(LS_PIN, pin); }
  function getPin() { return T1.storage.get(LS_PIN, ''); }
  function lock() { T1.storage.set(LS_LOCKED, '1'); overlay.classList.add('active'); }
  function unlock() {
    const stored = getPin();
    if (stored && input.value !== stored) {
      T1.toast('Wrong PIN', 'error');
      return;
    }
    T1.storage.del(LS_LOCKED);
    overlay.classList.remove('active');
    input.value = '';
    T1.toast('Unlocked');
  }

  btn.addEventListener('click', unlock);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });

  // NOTE: WebAuthn credential creation/verification is intentionally not
  // wired here — it requires a secure context (HTTPS or localhost) plus a
  // registered credential, neither of which a generic browser terminal can
  // assume. This feature degrades to a local PIN. The PIN is stored in
  // same-origin localStorage (cleartext) — acceptable threat model for a
  // single-user local terminal; do NOT reuse this pattern for multi-user or
  // remote-deployed apps.
  function tryWebAuthn() { return Promise.resolve(false); }

  // Auto-lock if previously locked.
  if (T1.storage.get(LS_LOCKED, '0') === '1') lock();

  // Toolbar button.
  const lockBtn = T1.ui.makeButton('Lock', 'Lock this session', () => {
    if (!getPin()) {
      let pin = prompt('Create a 4-8 digit PIN');
      if (!pin) return;
      pin = pin.trim();
      if (!/^\d{4,8}$/.test(pin)) {
        T1.toast('PIN must be 4-8 digits', 'warn');
        return;
      }
      setPin(pin);
    }
    lock();
  });
  T1.ui.toolbar().appendChild(lockBtn);

  window.__terminalOneSessionLock = { lock, unlock, setPin, getPin, overlay, tryWebAuthn };
}
