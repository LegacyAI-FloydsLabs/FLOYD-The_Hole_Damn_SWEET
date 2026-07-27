/**
 * Clipboard feature — Paste the system clipboard into the terminal, and Copy
 * the current terminal selection. Mobile browsers make pasting into a terminal
 * painful; these give one-tap access. Every clipboard call runs inside the tap
 * gesture so the browser permits it, and every failure degrades to a toast.
 */
export function init(T1) {
  const tb = T1.ui.toolbar();
  if (!tb) return;

  const paste = T1.ui.makeButton('Paste', 'Paste clipboard into terminal', async () => {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      T1.toast('Clipboard read not supported — use keyboard paste', 'warn');
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text) T1.sendData(text);
    } catch (_) {
      T1.toast('Clipboard read blocked by the browser', 'warn');
    }
  });

  const copy = T1.ui.makeButton('Copy', 'Copy terminal selection', async () => {
    const term = T1.term;
    const sel = term && typeof term.getSelection === 'function' ? term.getSelection() : '';
    if (!sel) { T1.toast('No text selected', 'warn'); return; }
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      T1.toast('Clipboard write not supported', 'warn');
      return;
    }
    try { await navigator.clipboard.writeText(sel); T1.toast('Copied'); }
    catch (_) { T1.toast('Copy blocked by the browser', 'warn'); }
  });

  const selectAll = T1.ui.makeButton('Select all', 'Select all scrollback and copy', async () => {
    const term = T1.term;
    if (!term || typeof term.selectAll !== 'function') { T1.toast('Select all not supported', 'warn'); return; }
    term.selectAll();
    const sel = term.getSelection();
    if (!sel) { T1.toast('No text selected', 'warn'); return; }
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      T1.toast('Clipboard write not supported', 'warn');
      return;
    }
    try { await navigator.clipboard.writeText(sel); T1.toast('Copied all scrollback'); }
    catch (_) { T1.toast('Copy blocked by the browser', 'warn'); }
  });

  tb.appendChild(paste);
  tb.appendChild(copy);
  tb.appendChild(selectAll);

  // Keyboard shortcut: Ctrl/Cmd+Shift+A
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      selectAll.click();
    }
  });
}
