import { beforeEach, describe, expect, it } from 'vitest';
import {
  getPanelLocation,
  handleCanvasFileDrop,
  spawnPanelOnCanvas,
} from '@/panels/panelOps';
import { panelIdForType } from '@/panels/types';
import { getPrimaryCanvasStore, resetCanvasRegistry } from '@/canvas/canvasRegistry';
import { getPanelLocation as getDockPanelLocation, resetDockStore, useDockStore } from '@/dock/dockStore';
import { useEditorStore } from '@/store/editorStore';

describe('panel ops — one-location invariant across dock and canvas', () => {
  beforeEach(() => {
    localStorage.clear();
    useEditorStore.getState().resetForWorkspace();
    resetCanvasRegistry();
    resetDockStore();
  });

  it('spawnPanelOnCanvas focuses the existing node instead of duplicating the singleton', () => {
    const first = spawnPanelOnCanvas('terminal');
    const second = spawnPanelOnCanvas('terminal');
    expect(second).toBe(first);
    expect(Object.keys(getPrimaryCanvasStore().getState().nodes)).toHaveLength(1);
  });

  it('spawning a docked panel onto the canvas pulls it out of the dock tree', () => {
    spawnPanelOnCanvas('terminal');
    const zones = useDockStore.getState().zones;
    expect(getDockPanelLocation(zones, panelIdForType('terminal'))).toBeNull();
    expect(getPanelLocation(panelIdForType('terminal'))).toMatchObject({ kind: 'canvas' });
  });

  it('docking a panel that lives on the canvas removes its node', () => {
    spawnPanelOnCanvas('ai-chat');
    expect(getPanelLocation(panelIdForType('ai-chat'))).toMatchObject({ kind: 'canvas' });
    const dock = useDockStore.getState();
    dock.dockPanel({ id: panelIdForType('ai-chat'), type: 'ai-chat', title: 'Coding Partner' }, 'right');
    expect(getPanelLocation(panelIdForType('ai-chat'))).toMatchObject({ kind: 'dock', zoneId: 'right' });
    expect(Object.keys(getPrimaryCanvasStore().getState().nodes)).toHaveLength(0);
  });

  it('file drop opens the tab and spawns the editor node at the drop point when missing', () => {
    handleCanvasFileDrop('/projects/test/src/a.ts', { x: 400, y: 300 });
    expect(useEditorStore.getState().activeTabPath).toBe('/projects/test/src/a.ts');
    const nodes = Object.values(getPrimaryCanvasStore().getState().nodes);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].panel.type).toBe('editor');
    // Node is centered on the drop point (origin = point - half default size).
    expect(nodes[0].origin).toEqual({ x: 40, y: 40 });
  });

  it('file drop with an existing editor node focuses it instead of duplicating', () => {
    handleCanvasFileDrop('/projects/test/src/a.ts', { x: 400, y: 300 });
    handleCanvasFileDrop('/projects/test/src/b.ts', { x: 900, y: 900 });
    expect(Object.keys(getPrimaryCanvasStore().getState().nodes)).toHaveLength(1);
    expect(useEditorStore.getState().tabs.map((tab) => tab.path)).toEqual([
      '/projects/test/src/a.ts',
      '/projects/test/src/b.ts',
    ]);
  });
});
