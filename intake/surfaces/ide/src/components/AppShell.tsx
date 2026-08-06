import { lazy, Suspense, useEffect, useLayoutEffect, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useUIStore, type SidePanel } from '@/store/uiStore';
import { useEditorStore } from '@/store/editorStore';
import { FileTree, SearchPanel } from '@/workspace';
import { EditorPane } from '@/editor/EditorPane';
import { InlineEditOverlay } from '@/editor/InlineEditOverlay';
import { CommandPalette } from './CommandPalette';
import { TabBar } from './TabBar';
import { StatusBar } from './StatusBar';
import { TitleBar } from './TitleBar';
import { Icon, type IconName } from './Icon';
import { SettingsDialog } from './SettingsDialog';
import { HelpDialog } from './HelpDialog';
import { ToastRegion } from './ToastRegion';
import { EditorToolbar } from './EditorToolbar';
import { useWorkspace } from '@/workspace';
import { applyThemeToElement, publishBootSnapshot } from '@/theme';
import { fontStack } from '@/font';

const TerminalPane = lazy(() => import('@/terminal/TerminalPane').then((module) => ({ default: module.TerminalPane })));
const AIChatPane = lazy(() => import('@/opencode/AIChatPane').then((module) => ({ default: module.AIChatPane })));
const GitPanel = lazy(() => import('@/git/GitPanel').then((module) => ({ default: module.GitPanel })));
const DebugPanel = lazy(() => import('@/debug/DebugPanel').then((module) => ({ default: module.DebugPanel })));
const ExtensionsPanel = lazy(() => import('./ExtensionsPanel').then((module) => ({ default: module.ExtensionsPanel })));

const activityItems: Array<{ panel: SidePanel; label: string; icon: IconName; shortcut?: string }> = [
  { panel: 'explorer', label: 'Explorer', icon: 'files', shortcut: '⌘B' },
  { panel: 'search', label: 'Search', icon: 'search', shortcut: '⌘⇧F' },
  { panel: 'git', label: 'Source Control', icon: 'source' },
  { panel: 'debug', label: 'Run and Debug', icon: 'debug' },
  { panel: 'extensions', label: 'Integrations', icon: 'extensions' },
];

export function AppShell() {
  const ui = useUIStore();
  const { openWorkspace } = useWorkspace();
  const { tabs, activeTabPath, closeTab, reopenClosedTab } = useEditorStore();

  useLayoutEffect(() => {
    const root = document.documentElement;
    const resolved = applyThemeToElement(ui.preferences.theme, root);
    publishBootSnapshot(resolved);
    root.style.setProperty('--workbench-font-family', fontStack(ui.preferences.fontFamily));
    root.dataset.motion = ui.preferences.reducedMotion ? 'reduced' : 'full';
  }, [ui.preferences.fontFamily, ui.preferences.reducedMotion, ui.preferences.theme]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (command && event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); ui.openPalette('commands'); return; }
      if (command && event.key.toLowerCase() === 'p') { event.preventDefault(); ui.openPalette('files'); return; }
      if (command && event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); ui.setPanel('search'); return; }
      if (command && event.shiftKey && event.key.toLowerCase() === 'a') { event.preventDefault(); ui.toggleAIChat(); return; }
      if (command && event.shiftKey && event.key.toLowerCase() === 't') { event.preventDefault(); reopenClosedTab(); return; }
      if (command && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        ui.setPanel('explorer');
        void openWorkspace()
          .then((selected) => selected && ui.addToast(`Opened ${selected.project.name} as the workspace.`, 'success'))
          .catch((error) => ui.addToast(error instanceof Error ? error.message : 'Could not open the selected folder.', 'error'));
        return;
      }
      if (command && event.key.toLowerCase() === 'b') { event.preventDefault(); ui.setPanel(ui.activePanel ? null : 'explorer'); return; }
      if (command && event.key.toLowerCase() === 'j') { event.preventDefault(); ui.toggleTerminal(); return; }
      if (command && event.key === ',') { event.preventDefault(); ui.openDialog('settings'); return; }
      if (command && event.key.toLowerCase() === 'w' && activeTabPath) {
        event.preventDefault();
        const tab = tabs.find((item) => item.path === activeTabPath);
        if (!tab?.isDirty || window.confirm(`Close ${activeTabPath.split('/').pop()} without saving?`)) closeTab(activeTabPath);
        return;
      }
      if (event.key === 'F1') { event.preventDefault(); ui.openDialog('help'); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTabPath, closeTab, openWorkspace, reopenClosedTab, tabs, ui]);

  const renderSidePanel = () => {
    switch (ui.activePanel) {
      case 'explorer': return <FileTree />;
      case 'search': return <SearchPanel />;
      case 'git': return <GitPanel />;
      case 'debug': return <DebugPanel />;
      case 'extensions': return <ExtensionsPanel />;
      default: return null;
    }
  };

  const beginResize = (
    event: ReactPointerEvent,
    current: number,
    axis: 'x' | 'y',
    direction: 1 | -1,
    update: (value: number) => void,
  ) => {
    event.preventDefault();
    const start = axis === 'x' ? event.clientX : event.clientY;
    const move = (moveEvent: PointerEvent) => {
      const position = axis === 'x' ? moveEvent.clientX : moveEvent.clientY;
      update(current + (position - start) * direction);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };

  const style = {
    '--side-panel-width': `${ui.sidePanelWidth}px`,
    '--terminal-height': `${ui.terminalHeight}px`,
    '--ai-panel-width': `${ui.aiPanelWidth}px`,
  } as CSSProperties;

  return (
    <div className="app-shell" style={style}>
      <TitleBar />
      <div className="app-main">
        <nav className="activity-bar" aria-label="Primary workbench views">
          <div className="activity-primary">
            {activityItems.map((item) => (
              <button key={item.panel} className={`activity-bar-item ${ui.activePanel === item.panel ? 'active' : ''}`} onClick={() => ui.togglePanel(item.panel)} title={`${item.label}${item.shortcut ? ` (${item.shortcut})` : ''}`} aria-label={item.label} aria-pressed={ui.activePanel === item.panel}>
                <Icon name={item.icon} size={21} />
              </button>
            ))}
          </div>
          <button className="activity-bar-item" onClick={() => ui.openDialog('settings')} title="Settings" aria-label="Settings"><Icon name="settings" size={21} /></button>
        </nav>

        {ui.activePanel && <><aside className="side-panel"><Suspense fallback={<p className="panel-caption">Loading workbench view…</p>}>{renderSidePanel()}</Suspense></aside><div className="resize-handle vertical" onPointerDown={(event) => beginResize(event, ui.sidePanelWidth, 'x', 1, ui.setSidePanelWidth)} aria-hidden="true" /></>}

        <main className="app-content">
          <section className="editor-area" aria-label="Editor">
            <TabBar />
            <EditorToolbar />
            <EditorPane />
          </section>
          {ui.terminalVisible && <><div className="resize-handle horizontal" onPointerDown={(event) => beginResize(event, ui.terminalHeight, 'y', -1, ui.setTerminalHeight)} aria-hidden="true" /><Suspense fallback={<p className="panel-caption">Loading terminal…</p>}><TerminalPane /></Suspense></>}
        </main>

        {ui.aiChatVisible && <><div className="resize-handle vertical" onPointerDown={(event) => beginResize(event, ui.aiPanelWidth, 'x', -1, ui.setAIPanelWidth)} aria-hidden="true" /><Suspense fallback={<p className="panel-caption">Loading coding partner…</p>}><AIChatPane /></Suspense></>}
      </div>
      <StatusBar />
      {ui.paletteMode && <CommandPalette mode={ui.paletteMode} onClose={ui.closePalette} />}
      {ui.dialog === 'settings' && <SettingsDialog />}
      {ui.dialog === 'help' && <HelpDialog />}
      <ToastRegion />
      <InlineEditOverlay />
    </div>
  );
}
