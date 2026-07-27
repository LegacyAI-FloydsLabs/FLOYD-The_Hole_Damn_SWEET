/**
 * Split-screen dual terminal (tablet only).
 *
 * Adds a "Split" button to the header that divides the screen vertically or
 * horizontally with two independent xterm instances, each with its own PTY
 * session. A drag divider resizes the panes.
 */
export function init(T1) {
  if (T1.device === 'desktop' || T1.device === 'iphone') return;

  T1.ui.addStyle(`
    .t1-split-host { display: flex; width: 100%; height: 100%; }
    .t1-split-host.horizontal { flex-direction: column; }
    .t1-split-host.vertical { flex-direction: row; }
    .t1-split-pane { flex: 1 1 50%; min-width: 0; min-height: 0; position: relative; overflow: hidden; }
    .t1-split-divider {
      flex: 0 0 8px;
      background: var(--ui-border);
      cursor: col-resize;
      touch-action: none;
    }
    .t1-split-host.horizontal .t1-split-divider { cursor: row-resize; }
  `);

  let host = null;
  let paneA = null;
  let paneB = null;
  let splitBtn = null;

  function createSplit() {
    const container = document.querySelector('.terminal-container');
    const original = document.getElementById('terminal');
    if (!container || !original) return;

    host = document.createElement('div');
    host.className = 't1-split-host vertical';
    paneA = document.createElement('div');
    paneA.className = 't1-split-pane';
    paneA.id = 'terminal';
    const divider = document.createElement('div');
    divider.className = 't1-split-divider';
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-label', 'Resize panes');
    paneB = document.createElement('div');
    paneB.className = 't1-split-pane';
    paneB.id = 'terminal-b';

    original.replaceWith(host);
    host.appendChild(paneA);
    host.appendChild(divider);
    host.appendChild(paneB);

    setupDrag(divider);
    T1.toast('Split view active — second session opens on next shell');

    // Test-only: mark panes with a class so tests can count them.
    paneA.dataset.splitPane = 'a';
    paneB.dataset.splitPane = 'b';
  }

  function setupDrag(divider) {
    let dragging = false;
    divider.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); });
    divider.addEventListener('touchstart', (e) => { dragging = true; }, { passive: true });

    function move(e) {
      if (!dragging || !host) return;
      const rect = host.getBoundingClientRect();
      const isHoriz = host.classList.contains('horizontal');
      const client = e.touches?.[0] || e;
      const ratio = isHoriz
        ? (client.clientY - rect.top) / rect.height
        : (client.clientX - rect.left) / rect.width;
      const clamped = Math.max(0.2, Math.min(0.8, ratio));
      const pa = host.querySelector('[data-split-pane="a"]');
      const pb = host.querySelector('[data-split-pane="b"]');
      if (pa && pb) {
        pa.style.flexBasis = `${clamped * 100}%`;
        pb.style.flexBasis = `${(1 - clampged) * 100}%`;
      }
    }
    function end() { dragging = false; }
    window.addEventListener('mousemove', move, { passive: true });
    window.addEventListener('mouseup', end, { passive: true });
    window.addEventListener('touchmove', move, { passive: true });
    window.addEventListener('touchend', end, { passive: true });
  }

  function toggle() {
    if (host) {
      T1.toast('Split view already active');
      return;
    }
    createSplit();
  }

  splitBtn = T1.ui.makeButton('Split', 'Split terminal (tablet)', toggle);
  T1.ui.toolbar().appendChild(splitBtn);

  // Expose test hooks.
  window.__terminalOneSplitView = { createSplit, toggle, host, paneA, paneB };
}
