import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { HostProvider } from '@/platform/HostProvider';
import { MockHostGateway } from '@/platform/host';
import { WorkspaceProvider } from '@/workspace/WorkspaceProvider';
import { AppShell } from '@/components/AppShell';
import { resetDockStore, useDockStore } from '@/dock/dockStore';
import { resetCanvasRegistry } from '@/canvas/canvasRegistry';
import { useEditorStore } from '@/store/editorStore';
import { DEFAULT_PREFERENCES, useUIStore } from '@/store/uiStore';
import { panelIdForType } from '@/panels/types';

// jsdom has no ResizeObserver; CanvasView only needs the callbacks to exist.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: ResizeObserverStub });
});

function renderShell() {
  const gateway = new MockHostGateway({ workspaceId: 'test', workspaceRoot: '/projects/test' });
  return render(
    <HostProvider config={gateway.config} gateway={gateway}>
      <WorkspaceProvider>
        <AppShell />
      </WorkspaceProvider>
    </HostProvider>,
  );
}

describe('AppShell on the dock + canvas substrate', () => {
  beforeEach(() => {
    localStorage.clear();
    useUIStore.setState({
      activePanel: 'explorer', terminalVisible: false, aiChatVisible: false,
      sidePanelWidth: 272, terminalHeight: 240, aiPanelWidth: 470,
      preferences: DEFAULT_PREFERENCES, toasts: [], paletteMode: null, dialog: null,
    });
    useEditorStore.getState().resetForWorkspace();
    resetCanvasRegistry();
    resetDockStore();
  });

  it('renders activity bar, left dock zone with the active side panel, and the canvas in center', async () => {
    renderShell();
    expect(screen.getByRole('button', { name: 'Explorer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Source Control' })).toBeInTheDocument();

    // Left zone visible with the Explorer tab; bottom/right zones hidden.
    const leftZone = document.querySelector('.dock-zone-left');
    expect(leftZone).not.toBeNull();
    expect(document.querySelector('.dock-zone-bottom')).toBeNull();
    expect(document.querySelector('.dock-zone-right')).toBeNull();

    // The primary canvas mounts inside the center zone (lazy chunk).
    await waitFor(() => expect(document.querySelector('.dock-zone-center .canvas-viewport')).not.toBeNull());
  });

  it('mirrors uiStore visibility flags into dock zones', () => {
    renderShell();
    act(() => useUIStore.getState().toggleTerminal());
    expect(useDockStore.getState().zones.bottom.visible).toBe(true);
    act(() => useUIStore.getState().toggleAIChat());
    expect(useDockStore.getState().zones.right.visible).toBe(true);
    act(() => useUIStore.getState().setPanel(null));
    expect(useDockStore.getState().zones.left.visible).toBe(false);
  });

  it('docks a newly activated side panel into the left zone as a tab', () => {
    renderShell();
    act(() => useUIStore.getState().setPanel('git'));
    const zones = useDockStore.getState().zones;
    const leftTabs = JSON.stringify(zones.left.layout);
    expect(leftTabs).toContain(panelIdForType('git'));
    expect(zones.left.visible).toBe(true);
  });
});
