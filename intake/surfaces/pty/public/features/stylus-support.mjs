/**
 * Stylus / Apple Pencil support (tablet).
 *
 * Pointer events from a stylus bypass xterm selection and draw a transient
 * highlight/annotation layer. Long-press with the stylus opens a context menu.
 */
export function init(T1) {
  if (T1.device === 'desktop' || T1.device === 'iphone') return;

  T1.ui.addStyle(`
    .t1-stylus-layer {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 200;
    }
    .t1-stylus-menu {
      position: fixed;
      background: var(--ui-elevated);
      border: 1px solid var(--ui-border);
      border-radius: 6px;
      padding: 4px 0;
      z-index: 210;
      display: none;
      min-width: 120px;
    }
    .t1-stylus-menu button {
      display: block;
      width: 100%;
      padding: 8px 12px;
      background: transparent;
      border: none;
      color: var(--ui-fg);
      text-align: left;
      font-size: 13px;
      cursor: pointer;
    }
    .t1-stylus-menu button:active { background: var(--ui-accent); color: #000; }
  `);

  const canvas = document.createElement('canvas');
  canvas.className = 't1-stylus-layer';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const menu = document.createElement('div');
  menu.className = 't1-stylus-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <button type="button" role="menuitem" data-action="copy">Copy</button>
    <button type="button" role="menuitem" data-action="paste">Paste</button>
    <button type="button" role="menuitem" data-action="select-all">Select All</button>
    <button type="button" role="menuitem" data-action="clear">Clear</button>
  `;
  document.body.appendChild(menu);

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize, { passive: true });

  let drawing = false;
  let longTimer = null;
  let menuPos = null;

  function hideMenu() { menu.style.display = 'none'; menuPos = null; }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'pen') return;
    drawing = true;
    ctx.beginPath();
    ctx.moveTo(e.clientX, e.clientY);
    ctx.strokeStyle = 'rgba(122,162,247,0.6)';
    ctx.lineWidth = 2;
    longTimer = setTimeout(() => {
      drawing = false;
      menuPos = { x: e.clientX, y: e.clientY };
      menu.style.left = `${e.clientX}px`;
      menu.style.top = `${e.clientY}px`;
      menu.style.display = 'block';
    }, 600);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drawing || e.pointerType !== 'pen') return;
    ctx.lineTo(e.clientX, e.clientY);
    ctx.stroke();
    if (longTimer) { clearTimeout(longTimer); longTimer = null; }
  });

  canvas.addEventListener('pointerup', (e) => {
    drawing = false;
    if (longTimer) { clearTimeout(longTimer); longTimer = null; }
  });

  menu.addEventListener('click', (e) => {
    const action = e.target.dataset.action;
    if (!action) return;
    hideMenu();
    if (action === 'copy') document.execCommand('copy');
    if (action === 'paste') document.execCommand('paste');
    if (action === 'select-all') {
      const term = T1.term;
      if (term) term.selectAll();
    }
    if (action === 'clear') {
      const term = T1.term;
      if (term) term.clear();
    }
  });

  // Expose for tests.
  window.__terminalOneStylus = { canvas, menu, hideMenu, resize };
}
