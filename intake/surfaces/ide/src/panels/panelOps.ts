// CURSE'M IDE — panel operations.
//
// Coordination layer over the dock store, the canvas registry, and the
// editor store. Panels are singletons with exactly one location — a dock
// zone tab or a canvas node — and this module is the only place that moves
// them between substrates, so the two stores can never disagree about where
// a panel lives. Location is derived on demand (getPanelLocation), never
// cached.
//
// The editor is a single tab-stack component (Monaco hosts every buffer),
// so unlike Cate's per-file editor panels, CURSEM keeps ONE editor panel:
// dropping a file onto the canvas opens it as a tab and focuses the editor
// node; only if no editor node exists is one spawned at the drop point.

import { useEditorStore } from '@/store/editorStore';
import { panelIdForType, type PanelState, type PanelType } from './types';
import { getPanelDefinition } from './registry';
import { getPrimaryCanvasStore } from '@/canvas/canvasRegistry';
import { getPanelLocation as getDockPanelLocation, setPanelMoveInterceptor, useDockStore, type DockZoneId } from '@/dock/dockStore';
import { nodeCenter } from '@/canvas/helpers';
import type { Point } from '@/canvas/types';

// Registered into dockStore at module load: docking a panel that currently
// lives on a canvas removes its node first (one-location invariant).
setPanelMoveInterceptor((panelId) => {
  const canvas = getPrimaryCanvasStore().getState();
  for (const node of Object.values(canvas.nodes)) {
    if (node.panel.id === panelId) canvas.removeNode(node.id);
  }
});

export function panelStateFor(type: PanelType): PanelState {
  return { id: panelIdForType(type), type, title: getPanelDefinition(type).title };
}

export type PanelLocation =
  | { kind: 'dock'; zoneId: DockZoneId; stackId: string }
  | { kind: 'canvas'; nodeId: string }
  | null;

/** Where a panel currently lives, derived fresh from both substrates. */
export function getPanelLocation(panelId: string): PanelLocation {
  const dockLocation = getDockPanelLocation(useDockStore.getState().zones, panelId);
  if (dockLocation) return { kind: 'dock', ...dockLocation };
  const canvas = getPrimaryCanvasStore().getState();
  for (const node of Object.values(canvas.nodes)) {
    if (node.panel.id === panelId) return { kind: 'canvas', nodeId: node.id };
  }
  return null;
}

function findCanvasNodeByType(type: PanelType): string | null {
  const canvas = getPrimaryCanvasStore().getState();
  const node = Object.values(canvas.nodes).find((entry) => entry.panel.type === type);
  return node?.id ?? null;
}

/**
 * Place a panel on the primary canvas. If a node already hosts it, focus and
 * center on that node instead of duplicating the singleton. If the panel is
 * docked, it is pulled out of the dock tree first (move semantics).
 */
export function spawnPanelOnCanvas(type: PanelType, origin?: Point): string {
  const canvas = getPrimaryCanvasStore();
  const existingId = findCanvasNodeByType(type);
  if (existingId) {
    const state = canvas.getState();
    state.focusNode(existingId);
    const node = state.nodes[existingId];
    if (node && state.containerSize.width > 0) {
      const center = nodeCenter(node);
      state.glideTo({
        x: state.containerSize.width / 2 - center.x * state.zoomLevel,
        y: state.containerSize.height / 2 - center.y * state.zoomLevel,
      });
    }
    return existingId;
  }
  const panel = panelStateFor(type);
  const dock = useDockStore.getState();
  dock.registerPanel(panel);
  if (getDockPanelLocation(dock.zones, panel.id)) dock.undockPanel(panel.id);
  return canvas.getState().addNode(panel, origin);
}

/** FileTree drop onto the canvas: open the file, then focus the editor node
 *  or spawn one centered on the drop point. */
export function handleCanvasFileDrop(path: string, worldPoint: Point): void {
  useEditorStore.getState().openTab(path);
  const existingId = findCanvasNodeByType('editor');
  if (existingId) {
    getPrimaryCanvasStore().getState().focusNode(existingId);
    return;
  }
  spawnPanelOnCanvas('editor', { x: worldPoint.x - 360, y: worldPoint.y - 260 });
}

/** Shell-mount seed: place the editor node once the canvas has a real
 *  container size, so default viewport-center placement is actually centered
 *  (the canvas chunk loads lazily, after AppShell's first effect run). */
export function seedEditorWhenReady(): void {
  const store = getPrimaryCanvasStore();
  if (store.getState().containerSize.width > 0) {
    ensureEditorVisible(true);
    return;
  }
  const unsubscribe = store.subscribe((state) => {
    if (state.containerSize.width > 0) {
      unsubscribe();
      ensureEditorVisible(true);
    }
  });
}

/** Guarantee the editor panel is reachable. With `always` (shell mount) the
 *  editor node is seeded even with no file open, so the WelcomeScreen keeps
 *  its home; otherwise only respawn when a file is active but the editor
 *  panel is nowhere on screen. */
export function ensureEditorVisible(always = false): void {
  const { activeTabPath } = useEditorStore.getState();
  if (!always && !activeTabPath) return;
  if (getPanelLocation(panelIdForType('editor'))) return;
  spawnPanelOnCanvas('editor');
}

// — Command palette / shortcut entry points (primary canvas) —

export function canvasAutoLayout(): void {
  getPrimaryCanvasStore().getState().autoLayout();
}

export function canvasZoomToFit(): void {
  getPrimaryCanvasStore().getState().zoomToFit();
}

export function canvasUndoLayout(): void {
  getPrimaryCanvasStore().getState().undoLayout();
}

export function canvasNewEditorAtCenter(): void {
  spawnPanelOnCanvas('editor');
}

export function canvasNewTerminalAtCenter(): void {
  spawnPanelOnCanvas('terminal');
}
