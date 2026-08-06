// CURSE'M IDE — canvas store factory.
//
// createCanvasStore() composes the slices (nodes/viewport/selection/
// navigation/arrange/history) into a per-surface Zustand store. One store
// instance per canvas panel, keyed in canvasRegistry — workspaces are fully
// isolated, matching Cate's getOrCreateCanvasStoreForPanel semantics onto a
// plain Map (CURSEM has no multi-renderer session to integrate with).
//
// Also home to viewport culling: selectVisibleNodeIds returns only nodes
// intersecting the viewport plus a one-screen margin (focused/pinned nodes
// exempt), so off-screen panel content never mounts.

import { create, type StoreApi } from 'zustand';
import type { CanvasStoreState } from './state';
import { ZOOM_DEFAULT, type CanvasNodeState } from './types';
import { createNodesSlice } from './slices/nodesSlice';
import { createViewportSlice } from './slices/viewportSlice';
import { createSelectionSlice } from './slices/selectionSlice';
import { createNavigationSlice } from './slices/navigationSlice';
import { createArrangeSlice } from './slices/arrangeSlice';
import { createHistorySlice } from './slices/historySlice';

export type CanvasStore = StoreApi<CanvasStoreState>;

export function createCanvasStore(): CanvasStore {
  return create<CanvasStoreState>()((set, get, api) => ({
    nodes: {},
    viewportOffset: { x: 0, y: 0 },
    zoomLevel: ZOOM_DEFAULT,
    containerSize: { width: 0, height: 0 },
    focusedNodeId: null,
    selectedNodeId: null,
    history: [],
    nextZOrder: 1,
    nextCreationIndex: 0,
    nextNodeSeq: 1,
    ...createNodesSlice(set, get, api),
    ...createViewportSlice(set, get, api),
    ...createSelectionSlice(set, get, api),
    ...createNavigationSlice(set, get, api),
    ...createArrangeSlice(set, get, api),
    ...createHistorySlice(set, get, api),
  }) as CanvasStoreState);
}

/** Ids of nodes that must mount: intersecting the viewport plus a
 *  one-screen margin, with focused/pinned nodes always kept alive.
 *  Returned in z-order (paint order). Compare with shallow id equality so
 *  pan/zoom frames that change nothing skip React entirely. */
export function selectVisibleNodeIds(state: CanvasStoreState): string[] {
  const { nodes, viewportOffset, zoomLevel, containerSize, focusedNodeId } = state;
  const marginX = containerSize.width / zoomLevel;
  const marginY = containerSize.height / zoomLevel;
  const viewX = -viewportOffset.x / zoomLevel - marginX;
  const viewY = -viewportOffset.y / zoomLevel - marginY;
  const viewW = containerSize.width / zoomLevel + marginX * 2;
  const viewH = containerSize.height / zoomLevel + marginY * 2;

  const visible: CanvasNodeState[] = [];
  for (const node of Object.values(nodes)) {
    const keepAlive = node.id === focusedNodeId || node.isPinned;
    const intersects =
      node.origin.x < viewX + viewW &&
      node.origin.x + node.size.width > viewX &&
      node.origin.y < viewY + viewH &&
      node.origin.y + node.size.height > viewY;
    if (keepAlive || intersects) visible.push(node);
  }
  visible.sort((a, b) => a.zOrder - b.zOrder);
  return visible.map((node) => node.id);
}

export function visibleNodeIdsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
