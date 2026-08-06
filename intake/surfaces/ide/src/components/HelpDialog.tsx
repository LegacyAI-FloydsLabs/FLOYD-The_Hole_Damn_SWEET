import { useEffect, useRef } from 'react';
import { Icon } from './Icon';
import { useUIStore } from '@/store/uiStore';

const shortcuts = [
  ['Open workspace', '⌘O'], ['Quick open', '⌘P'], ['Command palette', '⌘⇧P'], ['Save', '⌘S'],
  ['Undo / Redo', '⌘Z / ⌘⇧Z'], ['Global search', '⌘⇧F'], ['Toggle sidebar', '⌘B'],
  ['Toggle terminal', '⌘J'], ['Toggle AI chat', '⌘⇧A'], ['Settings', '⌘,'],
  ['CURSEM Inline Edit', '⌘K'],
  ['Canvas: navigate nodes', '⌘←→↑↓'], ['Canvas: pan viewport', '⇧←→↑↓'],
  ['Close editor', '⌘W'], ['Reopen editor', '⌘⇧T'], ['Help', 'F1'],
];

export function HelpDialog() {
  const closeDialog = useUIStore((state) => state.closeDialog);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => event.key === 'Escape' && closeDialog();
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeDialog]);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeDialog()}>
      <section className="dialog help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <header className="dialog-header">
          <div><p className="eyebrow">CURSEM IDE</p><h2 id="help-title" ref={headingRef} tabIndex={-1}>Keyboard reference</h2></div>
          <button className="icon-button" onClick={closeDialog} aria-label="Close help"><Icon name="close" /></button>
        </header>
        <div className="shortcut-grid">
          {shortcuts.map(([label, keys]) => <div className="shortcut-row" key={label}><span>{label}</span><kbd>{keys}</kbd></div>)}
        </div>
        <footer className="dialog-footer help-footer">
          <p>Privileged file, Git, terminal, and provider actions stay behind the loopback host boundary.</p>
          <button className="button primary" onClick={closeDialog}>Close</button>
        </footer>
      </section>
    </div>
  );
}
