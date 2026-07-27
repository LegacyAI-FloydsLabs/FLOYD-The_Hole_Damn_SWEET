/**
 * Export terminal scrollback — downloads the current buffer as a .txt file.
 *
 * ShellFish parity: save terminal output to a file.
 */
export function init(T1) {
  const tb = T1.ui.toolbar();
  if (!tb) return;

  const btn = T1.ui.makeButton('Export', 'Export terminal output as .txt', () => {
    const term = T1.term;
    if (!term || !term.buffer) {
      T1.toast('No terminal output to export', 'warn');
      return;
    }
    try {
      const buf = term.buffer.active;
      const lines = [];
      for (let i = 0; i < buf.length; i += 1) {
        const line = buf.getLine(i);
        lines.push(line ? line.translateToString(true) : '');
      }
      const text = lines.join('\n') + '\n';
      const blob = new Blob([text], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.download = `terminal-output-${now}.txt`;
      a.click();
      URL.revokeObjectURL(a.href);
      T1.toast('Terminal output exported');
    } catch (err) {
      T1.toast('Export failed', 'error');
    }
  });
  tb.appendChild(btn);
}
