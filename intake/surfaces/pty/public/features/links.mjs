/**
 * Link and filename actions — extends xterm's link handling with a context
 * menu, and makes obvious filenames in terminal output tappable.
 *
 * ShellFish parity: tap URLs/filenames to preview or copy them.
 */
export function init(T1) {
  const shell = T1.ui.appShell() || document.body;

  T1.ui.addStyle(`
    .t1link-menu {
      position: absolute;
      z-index: 500;
      background: var(--ui-elevated);
      border: 1px solid var(--ui-border);
      border-radius: 6px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      padding: 4px 0;
      min-width: 160px;
      display: none;
    }
    .t1link-menu.open { display: block; }
    .t1link-menu button {
      display: block;
      width: 100%;
      text-align: left;
      background: transparent;
      border: none;
      padding: 6px 12px;
      font-size: 12px;
      cursor: pointer;
    }
    .t1link-menu button:hover { background: var(--ui-bg); }
  `);

  const menu = document.createElement('div');
  menu.className = 't1link-menu';
  shell.appendChild(menu);

  function showMenu(x, y, targetUrl, filename) {
    menu.innerHTML = '';
    if (targetUrl) {
      const openBtn = document.createElement('button');
      openBtn.textContent = 'Open link';
      openBtn.addEventListener('click', () => { window.open(targetUrl, '_blank', 'noopener,noreferrer'); closeMenu(); });
      menu.appendChild(openBtn);
      const copyBtn = document.createElement('button');
      copyBtn.textContent = 'Copy link';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard?.writeText(targetUrl).catch(() => {});
        T1.toast('Link copied');
        closeMenu();
      });
      menu.appendChild(copyBtn);
    }
    if (filename) {
      const fileBtn = document.createElement('button');
      fileBtn.textContent = `Copy "${filename}"`;
      fileBtn.addEventListener('click', () => {
        navigator.clipboard?.writeText(filename).catch(() => {});
        T1.toast(`Filename copied: ${filename}`);
        closeMenu();
      });
      menu.appendChild(fileBtn);
    }
    menu.style.left = `${Math.min(x, window.innerWidth - 170)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 80)}px`;
    menu.classList.add('open');
  }

  function closeMenu() { menu.classList.remove('open'); }

  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) closeMenu(); });

  T1.onTermReady((term) => {
    const screenEl = term.element;
    if (!screenEl) return;

    // Right-click/long-press on links. xterm wraps link text in spans with
    // the xterm-decoration-inline-anchor class when WebLinksAddon is active.
    function onContextMenu(e) {
      const anchor = e.target.closest?.('a');
      if (anchor) {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, anchor.href, null);
        return;
      }
      // Filename heuristic: anything that looks like a path/file.
      const filename = extractFilename(e.target.textContent);
      if (filename) {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, null, filename);
      }
    }

    // Also add filename highlighting by scanning rows. We do not modify xterm
    // internals; instead we listen for mousemove and show a tooltip for paths.
    let tooltip = null;
    function onMouseMove(e) {
      const text = e.target.textContent || '';
      const filename = extractFilename(text);
      if (!filename) {
        if (tooltip) { tooltip.remove(); tooltip = null; }
        return;
      }
      if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.className = 't1link-menu';
        tooltip.style.position = 'absolute';
        tooltip.style.padding = '4px 8px';
        tooltip.style.pointerEvents = 'none';
        tooltip.textContent = filename;
        shell.appendChild(tooltip);
      }
      tooltip.style.left = `${e.clientX + 12}px`;
      tooltip.style.top = `${e.clientY + 12}px`;
      tooltip.classList.add('open');
    }
    function onMouseLeave() { if (tooltip) { tooltip.remove(); tooltip = null; } }

    screenEl.addEventListener('contextmenu', onContextMenu);
    screenEl.addEventListener('mousemove', onMouseMove);
    screenEl.addEventListener('mouseleave', onMouseLeave);

    return () => {
      screenEl.removeEventListener('contextmenu', onContextMenu);
      screenEl.removeEventListener('mousemove', onMouseMove);
      screenEl.removeEventListener('mouseleave', onMouseLeave);
      if (tooltip) { tooltip.remove(); tooltip = null; }
    };
  });
}

function extractFilename(text) {
  if (!text || text.length > 80) return null;
  // Match common file/path patterns: ./foo, /tmp/bar, foo.txt, dir/file.
  const m = text.match(/(?:[\w.~+-]+\/)+[\w.~+-]+|\/[\w.~+-\/]+|[\w.~+-]+\.[\w]{1,6}/);
  return m ? m[0] : null;
}
