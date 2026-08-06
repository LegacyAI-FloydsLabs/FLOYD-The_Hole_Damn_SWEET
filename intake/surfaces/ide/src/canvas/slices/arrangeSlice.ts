// CURSE'M IDE — canvas arrange slice.
//
// autoLayout reflows every node into a uniform grid covering the current
// viewport: creation order, column count derived from the viewport aspect
// (cols = round(sqrt(n * aspect))), cell height capped at 0.72 × cell width,
// 6px gutters. A history entry is pushed BEFORE mutating so the reflow is
// undoable (feature-map §Workflow 8).

import type { StateCreator } from 'zustand';
import type { CanvasStoreState } from '../state';

const LAYOUT_GAP = 6;

export const createArrangeSlice: StateCreator<CanvasStoreState, [], [], Partial<CanvasStoreState>> = (set, get) => ({
  autoLayout: () => {
    const state = get();
    const nodes = Object.values(state.nodes).sort((a, b) => a.creationIndex - b.creationIndex);
    const { width, height } = state.containerSize;
    if (nodes.length === 0 || width <= 0 || height <= 0) return;

    get().pushHistory();

    // The grid fills the currently visible world rect.
    const viewW = width / state.zoomLevel;
    const viewH = height / state.zoomLevel;
    const viewX = -state.viewportOffset.x / state.zoomLevel;
    const viewY = -state.viewportOffset.y / state.zoomLevel;

    const aspect = viewW / viewH;
    const cols = Math.max(1, Math.round(Math.sqrt(nodes.length * aspect)));
    const rows = Math.ceil(nodes.length / cols);
    const cellW = viewW / cols;
    const cellH = Math.min(viewH / rows, 0.72 * cellW);

    const next = { ...state.nodes };
    nodes.forEach((node, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      next[node.id] = {
        ...node,
        origin: { x: viewX + col * cellW + LAYOUT_GAP / 2, y: viewY + row * cellH + LAYOUT_GAP / 2 },
        size: { width: Math.max(120, cellW - LAYOUT_GAP), height: Math.max(90, cellH - LAYOUT_GAP) },
      };
    });
    set({ nodes: next });
  },
});
