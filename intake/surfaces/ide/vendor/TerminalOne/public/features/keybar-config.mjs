/**
 * Key bar configuration — show/hide button groups in Settings.
 *
 * ShellFish parity: customize the on-screen key bar.
 */
const LS_KEYBAR = 'terminalone.keybarConfig';

export function init(T1) {
  const panel = T1.ui.settingsPanel();
  if (!panel) return;

  const defaults = { mod: true, ctrl: true, nav: true, arrows: true, symbols: true };
  let cfg = { ...defaults };
  try {
    cfg = { ...defaults, ...JSON.parse(T1.storage.get(LS_KEYBAR, '{}')) };
  } catch (_) {}

  T1.ui.addStyle(`
    .t1keybar-cfg { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
    .t1keybar-cfg label { display: flex; align-items: center; gap: 6px; font-size: 12px; text-transform: none; letter-spacing: 0; cursor: pointer; }
  `);

  const row = document.createElement('div');
  row.className = 'settings-row';
  row.innerHTML = `
    <label>Key bar groups</label>
    <div class="t1keybar-cfg">
      <label><input type="checkbox" data-key="mod" ${cfg.mod ? 'checked' : ''}> Modifiers</label>
      <label><input type="checkbox" data-key="ctrl" ${cfg.ctrl ? 'checked' : ''}> Ctrl chords</label>
      <label><input type="checkbox" data-key="nav" ${cfg.nav ? 'checked' : ''}> Navigation</label>
      <label><input type="checkbox" data-key="arrows" ${cfg.arrows ? 'checked' : ''}> Arrows</label>
      <label><input type="checkbox" data-key="symbols" ${cfg.symbols ? 'checked' : ''}> Symbols</label>
    </div>
  `;
  panel.appendChild(row);

  function save() {
    T1.storage.set(LS_KEYBAR, JSON.stringify(cfg));
    apply();
  }

  function apply() {
    const iphone = document.getElementById('keybarIphone');
    const ipad = document.getElementById('keybarIpad');
    [iphone, ipad].forEach((bar) => {
      if (!bar) return;
      const groups = bar.querySelectorAll(':scope > .kb-group');
      groups.forEach((g, idx) => {
        // Heuristic: iPhone layout has 4 groups; iPad has 5.
        const key = ['mod', 'ctrl', 'arrows', 'symbols', 'nav'][idx];
        if (!key) return;
        g.style.display = cfg[key] ? '' : 'none';
      });
    });
  }

  row.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      cfg[cb.dataset.key] = cb.checked;
      save();
    });
  });

  // Apply on load and whenever key bars are rebuilt (orientation change).
  apply();
  window.addEventListener('orientationchange', () => setTimeout(apply, 250));
}
