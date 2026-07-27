import { Icon } from './Icon';
import { useEditorStore } from '@/store/editorStore';
import { useUIStore } from '@/store/uiStore';
import { usePlatform } from '@/platform';
import { useWorkspace } from '@/workspace';
import { ThemeArtwork } from './ThemeArtwork';

export function TitleBar() {
  const { config } = usePlatform();
  const { workspaceRoot } = useWorkspace();
  const activeTabPath = useEditorStore((state) => state.activeTabPath);
  const openPalette = useUIStore((state) => state.openPalette);
  const openDialog = useUIStore((state) => state.openDialog);
  const toggleTerminal = useUIStore((state) => state.toggleTerminal);
  const toggleAIChat = useUIStore((state) => state.toggleAIChat);

  const workspaceName = workspaceRoot.split('/').filter(Boolean).pop() || 'No workspace';
  const fileName = activeTabPath?.split('/').pop();

  return (
    <header className="title-bar">
      <div className="brand-lockup" aria-label="CURSEM IDE">
        <ThemeArtwork basePath={config.basePath} className="brand-mark" />
        <span className="brand-name">CURSEM</span>
        <span className="brand-product">STANDALONE IDE</span>
      </div>
      <button className="title-search" onClick={() => openPalette('files')} aria-label="Quick open files">
        <Icon name="search" size={14} />
        <span>{fileName ?? workspaceName}</span>
        <kbd>⌘P</kbd>
      </button>
      <nav className="title-actions" aria-label="Workbench controls">
        <button className="icon-button" onClick={() => toggleTerminal()} title="Toggle terminal (⌘J)" aria-label="Toggle terminal">
          <Icon name="terminal" />
        </button>
        <button className="icon-button" onClick={() => toggleAIChat()} title="Toggle AI chat (⌘⇧A)" aria-label="Toggle AI chat">
          <Icon name="spark" />
        </button>
        <button className="icon-button" onClick={() => openPalette('commands')} title="Command palette (⌘⇧P)" aria-label="Open command palette">
          <Icon name="command" />
        </button>
        <button className="icon-button" onClick={() => openDialog('settings')} title="Settings (⌘,)" aria-label="Open settings">
          <Icon name="settings" />
        </button>
      </nav>
    </header>
  );
}
