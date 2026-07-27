/**
 * Drag-to-reorder session tabs.
 *
 * Session tabs in the header can be dragged to reorder; the new order is
 * persisted to localStorage.
 */
const LS_ORDER = 'terminalone.sessionOrder';

export function init(T1) {
  const tabsEl = document.querySelector('.t1session-tabs');
  if (!tabsEl) return;

  T1.ui.addStyle(`
    .t1session-tab[draggable="true"] { cursor: grab; }
    .t1session-tab.dragging { opacity: 0.6; }
    .t1session-tab.drop-target { border-left: 2px solid var(--ui-accent); }
  `);

  function readOrder() {
    try { return JSON.parse(T1.storage.get(LS_ORDER, '[]')); }
    catch (_) { return []; }
  }
  function writeOrder(order) { T1.storage.set(LS_ORDER, JSON.stringify(order)); }

  function getIds() {
    return Array.from(tabsEl.querySelectorAll('.t1session-tab')).map((t) => t.dataset.sessionId).filter(Boolean);
  }

  function wire() {
    const tabs = tabsEl.querySelectorAll('.t1session-tab');
    for (const tab of tabs) {
      if (tab.dataset.reorderWired) continue;
      tab.dataset.reorderWired = '1';
      tab.draggable = true;
      tab.addEventListener('dragstart', (e) => {
        tab.classList.add('dragging');
        e.dataTransfer.setData('text/plain', tab.dataset.sessionId);
        e.dataTransfer.effectAllowed = 'move';
      });
      tab.addEventListener('dragend', () => {
        tab.classList.remove('dragging');
        tabsEl.querySelectorAll('.drop-target').forEach((t) => t.classList.remove('drop-target'));
        writeOrder(getIds());
      });
      tab.addEventListener('dragover', (e) => {
        e.preventDefault();
        const dragging = tabsEl.querySelector('.dragging');
        if (!dragging || dragging === tab) return;
        const after = tab.compareDocumentPosition(dragging) & Node.DOCUMENT_POSITION_FOLLOWING;
        if (after) tabsEl.insertBefore(dragging, tab.nextSibling);
        else tabsEl.insertBefore(dragging, tab);
      });
    }
  }

  const mo = new MutationObserver(wire);
  mo.observe(tabsEl, { childList: true });
  wire();

  // Expose for tests.
  window.__terminalOneTabReorder = { wire, readOrder, writeOrder, getIds };
}
