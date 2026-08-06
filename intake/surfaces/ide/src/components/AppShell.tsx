// CURSE'M IDE — application shell.
//
// The shell layout is a dock + canvas substrate (feature-map canvas-docking,
// Phase 3 S2): the three fixed panels of the old shell are now dock zones —
// left hosts the side panels (explorer/search/git/debug/extensions) as tabs,
// bottom hosts the terminal, right hosts the AI coding partner, and center
// hosts the primary infinite canvas whose nodes hold editor/terminal
// panels. Activity bar items toggle zone/panel visibility exactly as before
// (uiStore's activePanel/terminalVisible/aiChatVisible stay the persisted
// authority; the dock mirrors them).
//
// Zone sizes are the legacy uiStore numbers (sidePanelWidth/terminalHeight/
// aiPanelWidth), dragged via each zone's resize handle — same clamps, same
// persistence, now interpreted as dock zone sizes.

import { useEffect, useLayoutEffect } from 'react';
import { useUIStore, type SidePanel } from '@/store/uiStore';
import { useEditorStore } from '@/store/editorStore';
import { DockZone } from '@/dock/DockZone';
import { handleCanvasKeydown } from '@/canvas/canvasShortcuts';
import { ensureEditorVisible, seedEditorWhenReady } from '@/panels/panelOps';
import { CommandPalette } from './CommandPalette';
import { StatusBar } from './StatusBar';
import { TitleBar } from './TitleBar';
import { Icon, type IconName } from './Icon';
import { SettingsDialog } from './SettingsDialog';
import { HelpDialog } from './HelpDialog';
import { ToastRegion } from './ToastRegion';
import { InlineEditOverlay } from '@/editor/InlineEditOverlay';
import { useWorkspace } from '@/workspace';
import { applyThemeToElement, publishBootSnapshot } from '@/theme';
import { fontStack } from '@/font';

const activityItems: Array<{ panel: SidePanel; label: string; icon: IconName; shortcut?: string }> = [
  { panel: 'explorer', label: 'Explorer', icon: 'files', shortcut: '⌘B' },
  { panel: 'search', label: 'Search', icon: 'search', shortcut: '⌘⇧F' },
  { panel: 'git', label: 'Source Control', icon: 'source' },
  { panel: 'debug', label: 'Run and Debug', icon: 'debug' },
  { panel: 'extensions', label: 'Integrations', icon: 'extensions' },
  { panel: 'skills', label: 'Skills', icon: 'spark' },
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

  // If a file is active but the editor panel was closed off the canvas,
  // respawn its node — opening a file must always land somewhere visible.
  useEffect(() => {
    ensureEditorVisible();
  }, [activeTabPath]);

  // Shell mount: seed the editor node once the canvas has a real size, even
  // with no file open, so the WelcomeScreen keeps its home on the canvas
  // (the old shell always mounted the editor area).
  useEffect(() => {
    seedEditorWhenReady();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      // Canvas spatial nav first: Cmd+Arrow (navigate) / Shift+Arrow (pan).
      if (handleCanvasKeydown(event)) return;
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

  return (
    <div className="app-shell">
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

        <DockZone zoneId="left" />

        <div className="dock-center-column">
          <DockZone zoneId="center" />
          <DockZone zoneId="bottom" />
        </div>

        <DockZone zoneId="right" />
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
