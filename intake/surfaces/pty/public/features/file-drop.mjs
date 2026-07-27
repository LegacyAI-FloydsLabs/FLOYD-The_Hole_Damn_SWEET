/**
 * Desktop file drop into terminal.
 *
 * Dragging a file over the terminal shows a drop target; dropping pastes the
 * file path (or base64 data URL for images) into the terminal input.
 */
export function init(T1) {
  if (T1.device !== 'desktop') return;

  T1.ui.addStyle(`
    .t1-file-drop-target {
      position: fixed; inset: 0;
      background: rgba(122,162,247,0.15);
      border: 3px dashed var(--ui-accent);
      z-index: 500;
      display: none;
      align-items: center; justify-content: center;
      pointer-events: none;
    }
    .t1-file-drop-target.active { display: flex; }
    .t1-file-drop-target span { color: var(--ui-accent); font-size: 18px; font-weight: 600; }
  `);

  const overlay = document.createElement('div');
  overlay.className = 't1-file-drop-target';
  overlay.setAttribute('role', 'region');
  overlay.setAttribute('aria-label', 'Drop file to paste path');
  overlay.innerHTML = '<span>Drop file to paste path</span>';
  document.body.appendChild(overlay);

  const target = T1.term?.element || document.querySelector('.terminal-container') || document.body;

  function show(e) {
    e.preventDefault();
    overlay.classList.add('active');
  }
  function hide() { overlay.classList.remove('active'); }

  window.addEventListener('dragenter', show);
  window.addEventListener('dragover', show);
  window.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) hide(); });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    hide();
    const files = e.dataTransfer?.files;
    if (!files || !files.length) return;

    for (const file of files) {
      const isImage = file.type.startsWith('image/');
      if (isImage) {
        try {
          const reader = new FileReader();
          const dataUrl = await new Promise((resolve, reject) => {
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          T1.sendData(dataUrl);
          T1.toast(`Pasted image ${file.name}`);
        } catch (_) {
          // Browsers do not expose real filesystem paths to web pages for
          // security; fall back to the filename only.
          T1.sendData(file.name);
          T1.toast(`Pasted ${file.name}`, 'warn');
        }
      } else {
        // Browsers do not expose real filesystem paths to web pages; only the
        // filename is available. Sending a fabricated path would mislead the
        // shell, so we send the bare filename instead.
        T1.sendData(file.name);
        T1.toast(`Pasted ${file.name}`);
      }
    }
  });

  window.__terminalOneFileDrop = { overlay, show, hide };
}
