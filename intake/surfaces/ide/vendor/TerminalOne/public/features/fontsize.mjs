/**
 * Font size feature — A-/A+ buttons that resize the terminal font, show the
 * current size, persist the choice, and re-apply it after every reconnect
 * (the terminal instance is disposed and recreated on resume).
 */
const KEY = 'terminalone.fontSize';
const MIN = 8, MAX = 28, STEP = 1, DEFAULT = 14;

export function init(T1) {
  const tb = T1.ui.toolbar();
  if (!tb) return;

  T1.ui.addStyle(`
    .t1font-label {
      flex: 0 0 auto;
      min-width: 32px;
      text-align: center;
      font-size: 12px;
      color: var(--ui-muted);
      user-select: none;
      -webkit-user-select: none;
    }
  `);

  const clamp = (n) => Math.max(MIN, Math.min(MAX, n));
  let size = clamp(parseInt(T1.storage.get(KEY, String(DEFAULT)), 10) || DEFAULT);

  const label = document.createElement('span');
  label.className = 't1font-label';
  const render = () => { label.textContent = `${size}px`; };
  const apply = () => {
    const term = T1.term;
    if (term) { term.options.fontSize = size; T1.fit(); }
    render();
  };
  const bump = (delta) => {
    const next = clamp(size + delta);
    if (next === size) return;
    size = next;
    T1.storage.set(KEY, String(size));
    apply();
  };

  const minus = T1.ui.makeButton('A-', 'Decrease font size', () => bump(-STEP));
  const plus = T1.ui.makeButton('A+', 'Increase font size', () => bump(STEP));

  tb.appendChild(minus);
  tb.appendChild(label);
  tb.appendChild(plus);

  render();
  // The terminal is recreated on every (re)connect — re-apply the stored size.
  T1.onTermReady((term) => { term.options.fontSize = size; T1.fit(); });
}
