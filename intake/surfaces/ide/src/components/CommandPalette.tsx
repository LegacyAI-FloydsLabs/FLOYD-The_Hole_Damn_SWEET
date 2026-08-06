import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { useEditorStore } from '@/store/editorStore';
import { useUIStore, type PaletteMode } from '@/store/uiStore';
import { useWorkspace } from '@/workspace';
import { dispatchEditorCommand } from '@/editor/commands';
import {
  canvasAutoLayout,
  canvasNewEditorAtCenter,
  canvasNewTerminalAtCenter,
  canvasUndoLayout,
  canvasZoomToFit,
} from '@/panels/panelOps';
import { nextThemeId, resolveTheme } from '@/theme';

interface CommandPaletteProps {
  mode: PaletteMode;
  onClose: () => void;
}

interface PaletteItem {
  id: string;
  label: string;
  detail: string;
  keybinding?: string;
  action: () => void;
}

export function CommandPalette({ mode, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(mode === 'files');
  const { fs, openWorkspace } = useWorkspace();
  const tabs = useEditorStore((state) => state.tabs);
  const recentlyClosed = useEditorStore((state) => state.recentlyClosed);
  const openTab = useEditorStore((state) => state.openTab);
  const closeAllTabs = useEditorStore((state) => state.closeAllTabs);
  const reopenClosedTab = useEditorStore((state) => state.reopenClosedTab);
  const { toggleTerminal, toggleAIChat, togglePanel, setPanel, openDialog, updatePreferences, preferences, addToast } = useUIStore();

  useEffect(() => {
    if (mode !== 'files') return;
    let cancelled = false;
    setLoading(true);
    fs.walkFiles().then((files) => {
      if (!cancelled) setWorkspaceFiles(files.map((file) => file.path));
    }).catch(() => {
      if (!cancelled) setWorkspaceFiles([]);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [fs, mode]);

  const commandItems = useMemo<PaletteItem[]>(() => [
    { id: 'open-workspace', label: 'File: Open Folder as Workspace', detail: 'Choose a real local project directory', keybinding: '⌘O', action: () => {
      setPanel('explorer');
      void openWorkspace()
        .then((selected) => selected && addToast(`Opened ${selected.project.name} as the workspace.`, 'success'))
        .catch((error) => addToast(error instanceof Error ? error.message : 'Could not open the selected folder.', 'error'));
    } },
    { id: 'save', label: 'File: Save', detail: 'Write the active buffer', keybinding: '⌘S', action: () => dispatchEditorCommand('save') },
    { id: 'format', label: 'Editor: Format Document', detail: 'Run the active formatter', action: () => dispatchEditorCommand('format') },
    { id: 'undo', label: 'Editor: Undo', detail: 'Undo last edit', keybinding: '⌘Z', action: () => dispatchEditorCommand('undo') },
    { id: 'redo', label: 'Editor: Redo', detail: 'Redo last edit', keybinding: '⌘⇧Z', action: () => dispatchEditorCommand('redo') },
    { id: 'find', label: 'Editor: Find', detail: 'Find in active file', keybinding: '⌘F', action: () => dispatchEditorCommand('find') },
    { id: 'replace', label: 'Editor: Replace', detail: 'Replace in active file', keybinding: '⌥⌘F', action: () => dispatchEditorCommand('replace') },
    { id: 'search', label: 'Search: Find in Files', detail: 'Search workspace content', keybinding: '⌘⇧F', action: () => setPanel('search') },
    { id: 'terminal', label: 'View: Toggle Terminal', detail: 'Open TerminalOne panel', keybinding: '⌘J', action: toggleTerminal },
    { id: 'ai', label: 'View: Toggle Coding Partner', detail: 'Open multi-provider model pane', keybinding: '⌘⇧A', action: toggleAIChat },
    { id: 'explorer', label: 'View: Toggle Explorer', detail: 'Show workspace tree', keybinding: '⌘B', action: () => togglePanel('explorer') },
    { id: 'git', label: 'View: Source Control', detail: 'Show system Git state', action: () => setPanel('git') },
    { id: 'debug', label: 'View: Run and Debug', detail: 'Show platform debug controls', action: () => setPanel('debug') },
    { id: 'settings', label: 'Preferences: Open Settings', detail: 'Edit CURSEM workbench preferences', keybinding: '⌘,', action: () => openDialog('settings') },
    { id: 'help', label: 'Help: Keyboard Reference', detail: 'Show all shortcuts', keybinding: 'F1', action: () => openDialog('help') },
    { id: 'theme', label: 'Preferences: Cycle Color Theme', detail: `Current: ${resolveTheme(preferences.theme).definition.name}`, action: () => updatePreferences({ theme: nextThemeId(preferences.theme) }) },
    { id: 'close-all', label: 'View: Close All Editors', detail: 'Close every open editor', action: closeAllTabs },
    { id: 'reopen', label: 'View: Reopen Closed Editor', detail: recentlyClosed[0] ?? 'No recently closed editor', keybinding: '⌘⇧T', action: reopenClosedTab },
    { id: 'canvas-auto-layout', label: 'Canvas: Auto Layout', detail: 'Reflow every canvas node into a viewport grid (undoable)', action: canvasAutoLayout },
    { id: 'canvas-zoom-fit', label: 'Canvas: Zoom to Fit', detail: 'Frame all canvas nodes in the viewport', action: canvasZoomToFit },
    { id: 'canvas-new-editor', label: 'Canvas: New Editor at Center', detail: 'Place the editor panel on the canvas', action: canvasNewEditorAtCenter },
    { id: 'canvas-new-terminal', label: 'Canvas: New Terminal at Center', detail: 'Place the terminal panel on the canvas', action: canvasNewTerminalAtCenter },
    { id: 'canvas-undo-layout', label: 'Canvas: Undo Layout Change', detail: 'Restore the layout before the last auto-layout', action: canvasUndoLayout },
  ], [addToast, closeAllTabs, openDialog, openWorkspace, preferences.theme, recentlyClosed, reopenClosedTab, setPanel, toggleAIChat, togglePanel, toggleTerminal, updatePreferences]);

  const fileItems = useMemo<PaletteItem[]>(() => {
    const paths = workspaceFiles.length > 0 ? workspaceFiles : tabs.map((tab) => tab.path);
    return paths.map((path) => ({
      id: path,
      label: path.split('/').pop() || path,
      detail: path,
      action: () => openTab(path),
    }));
  }, [openTab, tabs, workspaceFiles]);

  const items = mode === 'commands' ? commandItems : fileItems;
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return items.slice(0, 100);
    return items.filter((item) => `${item.label} ${item.detail}`.toLocaleLowerCase().includes(needle)).slice(0, 100);
  }, [items, query]);

  const execute = useCallback((item: PaletteItem) => {
    item.action();
    onClose();
  }, [onClose]);

  const selectedRef = useRef<PaletteItem | null>(null);
  selectedRef.current = filtered[selectedIndex] ?? null;

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowDown') { event.preventDefault(); setSelectedIndex((index) => Math.min(index + 1, filtered.length - 1)); }
      if (event.key === 'ArrowUp') { event.preventDefault(); setSelectedIndex((index) => Math.max(index - 1, 0)); }
      if (event.key === 'Enter' && selectedRef.current) { event.preventDefault(); execute(selectedRef.current); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [execute, filtered.length, onClose]);

  useEffect(() => setSelectedIndex(0), [query]);

  return (
    <div className="command-palette-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label={mode === 'commands' ? 'Command palette' : 'Quick open'}>
        <div className="palette-input-row">
          <Icon name={mode === 'commands' ? 'command' : 'search'} size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={mode === 'commands' ? 'Type a command' : 'Search files by name'} autoFocus aria-label={mode === 'commands' ? 'Type a command' : 'Search files'} />
          <kbd>Esc</kbd>
        </div>
        <div className="command-list" role="listbox">
          {filtered.map((item, index) => (
            <button key={item.id} className={`command-item ${index === selectedIndex ? 'selected' : ''}`} onClick={() => execute(item)} onMouseEnter={() => setSelectedIndex(index)} role="option" aria-selected={index === selectedIndex}>
              <span><strong>{item.label}</strong><small>{item.detail}</small></span>
              {item.keybinding && <kbd>{item.keybinding}</kbd>}
            </button>
          ))}
          {loading && <div className="command-empty">Indexing workspace files</div>}
          {!loading && filtered.length === 0 && <div className="command-empty">No matching {mode === 'commands' ? 'commands' : 'files'}</div>}
        </div>
      </section>
    </div>
  );
}
