/**
 * Appearance studio — deep visual controls for TerminalOne, all in Settings:
 *  - Background image (upload / URL), position, size, and image opacity
 *  - Terminal plane opacity (the xterm background over the backdrop)
 *  - Font family (preset stacks + custom), size, line height, letter spacing
 *  - Cursor style / blink / color, foreground + accent color overrides
 *  - Trims: container padding, corner radius, header / toolbar / footer visibility
 * Everything persists locally and re-applies on every reconnect (the terminal
 * is disposed and recreated on resume). Reset restores stock appearance.
 */
const K = (name) => `terminalone.appearance.${name}`;
const BG_KEY = 'terminalone.appearance.bgImage'; // data URL or http(s) URL

const FONT_STACKS = {
  'jetbrains': `'JetBrains Mono', ui-monospace, Menlo, monospace`,
  'sf-mono': `ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace`,
  'fira': `'Fira Code', 'Fira Mono', ui-monospace, monospace`,
  'cascadia': `'Cascadia Code', 'Cascadia Mono', ui-monospace, monospace`,
  'ibm-plex': `'IBM Plex Mono', ui-monospace, monospace`,
  'courier': `'Courier New', Courier, monospace`,
};

const DEFAULTS = {
  bgPosition: 'center center',
  bgSize: 'cover',
  bgOpacity: '1',
  planeOpacity: '1',
  fontKey: '',       // '' = follow the terminal style (STYLES)
  customFont: '',
  fontSize: '',      // '' = follow the fontsize feature
  lineHeight: '1.2',
  letterSpacing: '0',
  cursorStyle: 'block',
  cursorBlink: 'true',
  cursorColor: '',   // '' = theme default
  fgColor: '',
  accentColor: '',
  padding: '8',
  radius: '0',
  showHeader: 'true',
  showToolbar: 'true',
  showFooter: 'true',
};

export function init(T1) {
  const panel = T1.ui.settingsPanel && T1.ui.settingsPanel();
  if (!panel) return;

  const get = (name) => T1.storage.get(K(name), DEFAULTS[name]);
  const set = (name, v) => T1.storage.set(K(name), String(v));

  T1.ui.addStyle(`
    #settingsModal .settings-panel { max-height: 86vh; overflow-y: auto; max-width: 420px; scrollbar-width: thin; }
    .ap-section { border-top: 1px solid var(--ui-border); margin-top: 14px; padding-top: 12px; }
    .ap-section > h3 { font-size: 11px; margin: 0 0 10px; color: var(--ui-accent); letter-spacing: .8px; text-transform: uppercase; }
    .ap-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 10px; }
    .ap-row { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .ap-row.wide { grid-column: 1 / -1; }
    .ap-row label { font-size: 10px; color: var(--ui-muted); text-transform: uppercase; letter-spacing: .5px; }
    .ap-row select, .ap-row input[type="text"], .ap-row input[type="url"] {
      width: 100%; background: var(--ui-bg); color: var(--ui-fg); border: 1px solid var(--ui-border);
      border-radius: 6px; padding: 6px 8px; font-size: 12px; font-family: inherit; }
    .ap-row input[type="range"] { width: 100%; accent-color: var(--ui-accent); }
    .ap-row .ap-val { font-size: 10px; color: var(--ui-muted); text-align: right; }
    .ap-row input[type="color"] { width: 100%; height: 28px; border: 1px solid var(--ui-border); border-radius: 6px; background: var(--ui-bg); padding: 2px; }
    .ap-inline { display: flex; gap: 8px; align-items: center; }
    .ap-inline label { font-size: 11px; color: var(--ui-fg); text-transform: none; letter-spacing: 0; }
    .ap-btn { background: var(--ui-bg); color: var(--ui-fg); border: 1px solid var(--ui-border); border-radius: 6px;
      padding: 6px 10px; font-size: 11px; cursor: pointer; }
    .ap-btn:hover { border-color: var(--ui-accent); }
    .ap-btn.danger:hover { border-color: #f87171; color: #f87171; }
    .ap-bg-preview { width: 100%; height: 54px; border-radius: 6px; border: 1px solid var(--ui-border);
      background: var(--ui-bg) center/cover no-repeat; }
    #appBackdrop { position: fixed; inset: 0; z-index: 0; background: center/cover no-repeat; pointer-events: none; display: none; }
    .app-shell { position: relative; z-index: 1; }
  `);

  // Backdrop layer behind the whole shell (below fxCanvas which is z-index'd by theme CSS).
  let backdrop = document.getElementById('appBackdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'appBackdrop';
    document.body.prepend(backdrop);
  }

  // ---- apply ----------------------------------------------------------------
  function hexToRgba(hex, alpha) {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
    if (!m) return hex;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
  }
  function currentThemeBg() {
    const t = T1.term && T1.term.options.theme;
    const bg = (t && t.background) || '#000000';
    const m = /^rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/.exec(bg);
    if (m) return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
    return bg.startsWith('#') ? bg.slice(0, 7) : '#000000';
  }
  function apply() {
    const term = T1.term;
    const bgImage = T1.storage.get(BG_KEY, '');

    // backdrop image
    if (bgImage) {
      backdrop.style.display = 'block';
      backdrop.style.backgroundImage = `url("${bgImage}")`;
      backdrop.style.backgroundPosition = get('bgPosition');
      backdrop.style.backgroundSize = get('bgSize');
      backdrop.style.opacity = get('bgOpacity');
    } else {
      backdrop.style.display = 'none';
    }

    // terminal plane opacity: alpha-blend the theme background so the backdrop
    // shows through. 1 = fully opaque stock look.
    if (term) {
      const alpha = Number(get('planeOpacity'));
      const themeBg = currentThemeBg();
      const theme = { ...term.options.theme };
      theme.background = alpha >= 1 && !bgImage ? themeBg : hexToRgba(themeBg, alpha);
      if (get('cursorColor')) theme.cursor = get('cursorColor');
      if (get('fgColor')) theme.foreground = get('fgColor');
      term.options.theme = theme;

      // typography
      const fontKey = get('fontKey');
      const custom = get('customFont').trim();
      if (custom) term.options.fontFamily = custom;
      else if (fontKey && FONT_STACKS[fontKey]) term.options.fontFamily = FONT_STACKS[fontKey];
      const fs = parseInt(get('fontSize'), 10);
      if (fs) { term.options.fontSize = Math.max(8, Math.min(32, fs)); }
      term.options.lineHeight = Math.max(1, Math.min(2, Number(get('lineHeight')) || 1.2));
      term.options.letterSpacing = Math.max(-2, Math.min(8, Number(get('letterSpacing')) || 0));

      // cursor
      term.options.cursorStyle = get('cursorStyle');
      term.options.cursorBlink = get('cursorBlink') === 'true';
      T1.fit();
    }

    // accent override
    if (get('accentColor')) document.documentElement.style.setProperty('--ui-accent', get('accentColor'));

    // trims
    const container = document.querySelector('.terminal-container');
    if (container) {
      container.style.padding = `${Math.max(0, Math.min(48, parseInt(get('padding'), 10) || 0))}px`;
      container.style.borderRadius = `${Math.max(0, Math.min(32, parseInt(get('radius'), 10) || 0))}px`;
      container.style.overflow = 'hidden';
    }
    const hdr = document.querySelector('.terminal-header');
    const tb = T1.ui.toolbar();
    const ftr = document.querySelector('.terminal-footer');
    if (hdr) hdr.style.display = get('showHeader') === 'true' ? '' : 'none';
    if (tb) tb.style.display = get('showToolbar') === 'true' ? '' : 'none';
    if (ftr) ftr.style.display = get('showFooter') === 'true' ? '' : 'none';
    T1.fit();
  }

  // ---- UI -------------------------------------------------------------------
  const actions = panel.querySelector('.settings-actions');
  const root = document.createElement('div');
  root.innerHTML = `
    <div class="ap-section">
      <h3>Background image</h3>
      <div class="ap-grid">
        <div class="ap-row wide"><div class="ap-bg-preview" data-ap="preview"></div></div>
        <div class="ap-row"><button class="ap-btn" data-ap="upload">Upload image…</button>
          <input type="file" accept="image/*" hidden data-ap="file"></div>
        <div class="ap-row"><button class="ap-btn danger" data-ap="clearbg">Remove image</button></div>
        <div class="ap-row wide"><label>Image URL</label><input type="url" placeholder="https://…" data-ap="bgurl"></div>
        <div class="ap-row"><label>Position</label>
          <select data-ap="bgPosition">
            <option value="center center">Center</option><option value="top left">Top left</option>
            <option value="top center">Top</option><option value="top right">Top right</option>
            <option value="center left">Left</option><option value="center right">Right</option>
            <option value="bottom left">Bottom left</option><option value="bottom center">Bottom</option>
            <option value="bottom right">Bottom right</option>
          </select></div>
        <div class="ap-row"><label>Fit</label>
          <select data-ap="bgSize">
            <option value="cover">Cover (fill)</option><option value="contain">Contain (fit)</option>
            <option value="auto">Actual size</option><option value="100% 100%">Stretch</option>
          </select></div>
        <div class="ap-row wide"><label>Image opacity</label>
          <input type="range" min="0.05" max="1" step="0.05" data-ap="bgOpacity"><div class="ap-val" data-val="bgOpacity"></div></div>
        <div class="ap-row wide"><label>Terminal plane opacity</label>
          <input type="range" min="0.2" max="1" step="0.05" data-ap="planeOpacity"><div class="ap-val" data-val="planeOpacity"></div></div>
      </div>
    </div>
    <div class="ap-section">
      <h3>Typography</h3>
      <div class="ap-grid">
        <div class="ap-row"><label>Font</label>
          <select data-ap="fontKey">
            <option value="">Style default</option>
            <option value="jetbrains">JetBrains Mono</option><option value="sf-mono">SF Mono</option>
            <option value="fira">Fira Code</option><option value="cascadia">Cascadia Code</option>
            <option value="ibm-plex">IBM Plex Mono</option><option value="courier">Courier</option>
          </select></div>
        <div class="ap-row"><label>Size (px)</label>
          <select data-ap="fontSize">
            <option value="">Toolbar A-/A+</option>
            ${[10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28].map((n) => `<option value="${n}">${n}px</option>`).join('')}
          </select></div>
        <div class="ap-row wide"><label>Custom font family</label>
          <input type="text" placeholder="e.g. 'Comic Mono', monospace" data-ap="customFont"></div>
        <div class="ap-row"><label>Line height</label>
          <input type="range" min="1" max="1.8" step="0.05" data-ap="lineHeight"><div class="ap-val" data-val="lineHeight"></div></div>
        <div class="ap-row"><label>Letter spacing</label>
          <input type="range" min="-1" max="4" step="0.5" data-ap="letterSpacing"><div class="ap-val" data-val="letterSpacing"></div></div>
      </div>
    </div>
    <div class="ap-section">
      <h3>Cursor & colors</h3>
      <div class="ap-grid">
        <div class="ap-row"><label>Cursor style</label>
          <select data-ap="cursorStyle"><option value="block">Block</option><option value="underline">Underline</option><option value="bar">Bar</option></select></div>
        <div class="ap-row"><label>Cursor blink</label>
          <select data-ap="cursorBlink"><option value="true">Blinking</option><option value="false">Steady</option></select></div>
        <div class="ap-row"><label>Cursor color</label><input type="color" data-ap="cursorColor" data-color></div>
        <div class="ap-row"><label>Text color</label><input type="color" data-ap="fgColor" data-color></div>
        <div class="ap-row"><label>Accent color</label><input type="color" data-ap="accentColor" data-color></div>
        <div class="ap-row"><label>&nbsp;</label><button class="ap-btn" data-ap="clearcolors">Reset colors</button></div>
      </div>
    </div>
    <div class="ap-section">
      <h3>Layout trims</h3>
      <div class="ap-grid">
        <div class="ap-row"><label>Padding</label>
          <input type="range" min="0" max="48" step="2" data-ap="padding"><div class="ap-val" data-val="padding"></div></div>
        <div class="ap-row"><label>Corner radius</label>
          <input type="range" min="0" max="32" step="2" data-ap="radius"><div class="ap-val" data-val="radius"></div></div>
        <div class="ap-row wide ap-inline">
          <label><input type="checkbox" data-ap="showHeader"> Header</label>
          <label><input type="checkbox" data-ap="showToolbar"> Toolbar</label>
          <label><input type="checkbox" data-ap="showFooter"> Footer</label>
        </div>
        <div class="ap-row wide"><button class="ap-btn danger" data-ap="resetall">Reset ALL appearance</button></div>
      </div>
    </div>`;
  panel.insertBefore(root, actions);

  const $ap = (name) => root.querySelector(`[data-ap="${name}"]`);
  const $val = (name) => root.querySelector(`[data-val="${name}"]`);
  const CONTROL_NAMES = Object.freeze({
    file: 'Background image file',
    bgurl: 'Background image URL',
    bgPosition: 'Background image position',
    bgSize: 'Background image fit',
    bgOpacity: 'Background image opacity',
    planeOpacity: 'Terminal plane opacity',
    fontKey: 'Terminal font',
    fontSize: 'Terminal font size',
    customFont: 'Custom font family',
    lineHeight: 'Terminal line height',
    letterSpacing: 'Terminal letter spacing',
    cursorStyle: 'Cursor style',
    cursorBlink: 'Cursor blink',
    cursorColor: 'Cursor color',
    fgColor: 'Terminal text color',
    accentColor: 'Interface accent color',
    padding: 'Terminal padding',
    radius: 'Terminal corner radius',
  });
  for (const [name, accessibleName] of Object.entries(CONTROL_NAMES)) {
    $ap(name)?.setAttribute('aria-label', accessibleName);
  }
  $ap('preview')?.setAttribute('role', 'img');
  $ap('preview')?.setAttribute('aria-label', 'Background image preview');

  function syncInputs() {
    for (const name of ['bgPosition', 'bgSize', 'fontKey', 'fontSize', 'cursorStyle', 'cursorBlink']) $ap(name).value = get(name);
    for (const name of ['bgOpacity', 'planeOpacity', 'lineHeight', 'letterSpacing', 'padding', 'radius']) {
      $ap(name).value = get(name);
      if ($val(name)) $val(name).textContent = get(name);
    }
    $ap('customFont').value = get('customFont');
    for (const name of ['cursorColor', 'fgColor', 'accentColor']) $ap(name).value = get(name) || '#000000';
    for (const name of ['showHeader', 'showToolbar', 'showFooter']) $ap(name).checked = get(name) === 'true';
    const img = T1.storage.get(BG_KEY, '');
    $ap('preview').style.backgroundImage = img ? `url("${img}")` : '';
    $ap('bgurl').value = img.startsWith('http') ? img : '';
  }

  // selects + text
  for (const name of ['bgPosition', 'bgSize', 'fontKey', 'fontSize', 'cursorStyle', 'cursorBlink']) {
    $ap(name).addEventListener('change', (e) => { set(name, e.target.value); apply(); });
  }
  $ap('customFont').addEventListener('change', (e) => { set('customFont', e.target.value); apply(); });
  // sliders
  for (const name of ['bgOpacity', 'planeOpacity', 'lineHeight', 'letterSpacing', 'padding', 'radius']) {
    $ap(name).addEventListener('input', (e) => {
      set(name, e.target.value);
      if ($val(name)) $val(name).textContent = e.target.value;
      apply();
    });
  }
  // colors
  for (const name of ['cursorColor', 'fgColor', 'accentColor']) {
    $ap(name).addEventListener('input', (e) => { set(name, e.target.value); apply(); });
  }
  $ap('clearcolors').addEventListener('click', () => {
    for (const name of ['cursorColor', 'fgColor', 'accentColor']) set(name, '');
    document.documentElement.style.removeProperty('--ui-accent');
    // rebuild theme from scratch by re-applying the current theme
    if (window.__terminalOne) window.__terminalOne.setTheme(window.__terminalOne.theme);
    syncInputs(); apply();
    T1.toast('Colors reset to theme defaults');
  });
  // toggles
  for (const name of ['showHeader', 'showToolbar', 'showFooter']) {
    $ap(name).addEventListener('change', (e) => { set(name, e.target.checked); apply(); });
  }
  // background image upload / URL / clear
  $ap('upload').addEventListener('click', () => $ap('file').click());
  $ap('file').addEventListener('change', () => {
    const f = $ap('file').files[0];
    if (!f) return;
    if (f.size > 6 * 1024 * 1024) { T1.toast('Image too large (max 6 MB)', 'error'); return; }
    const r = new FileReader();
    r.onload = () => {
      try { T1.storage.set(BG_KEY, r.result); }
      catch { T1.toast('Image too large for local storage — try a smaller one', 'error'); return; }
      syncInputs(); apply();
      T1.toast('Background image set');
    };
    r.readAsDataURL(f);
  });
  $ap('bgurl').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    if (v && !/^https?:\/\//.test(v)) { T1.toast('Use an http(s) image URL', 'error'); return; }
    T1.storage.set(BG_KEY, v);
    syncInputs(); apply();
  });
  $ap('clearbg').addEventListener('click', () => {
    T1.storage.set(BG_KEY, '');
    syncInputs(); apply();
    T1.toast('Background image removed');
  });
  // reset all
  $ap('resetall').addEventListener('click', () => {
    if (!confirm('Reset every appearance setting to stock?')) return;
    for (const name of Object.keys(DEFAULTS)) set(name, DEFAULTS[name]);
    T1.storage.set(BG_KEY, '');
    document.documentElement.style.removeProperty('--ui-accent');
    if (window.__terminalOne) window.__terminalOne.setTheme(window.__terminalOne.theme);
    syncInputs(); apply();
    T1.toast('Appearance reset');
  });

  syncInputs();
  apply();
  // The terminal is recreated on every (re)connect — re-apply everything.
  T1.onTermReady(() => apply());
  // Theme switches rebuild the xterm theme — re-blend opacity + overrides after.
  const themeSel = document.getElementById('themeSelect');
  if (themeSel) themeSel.addEventListener('change', () => setTimeout(apply, 0));
}
