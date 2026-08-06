// CURSE'M IDE — canvas history slice.
//
// Shallow layout snapshots for undo. Entries capture node geometry +
// viewport before a destructive arrange op; undoLayout restores the most
// recent entry. Capped at 50.

import type { StateCreator } from 'zustand';
import type { CanvasStoreState } from '../state';

const HISTORY_LIMIT = 50;

export const createHistorySlice: StateCreator<CanvasStoreState, [], [], Partial<CanvasStoreState>> = (set, get) => ({
  pushHistory: () => set((state) => ({
    history: [
      ...state.history.slice(-(HISTORY_LIMIT - 1)),
      {
        nodes: state.nodes,
        viewportOffset: state.viewportOffset,
        zoomLevel: state.zoomLevel,
        focusedNodeId: state.focusedNodeId,
        selectedNodeId: state.selectedNodeId,
      },
    ],
  })),

  undoLayout: () => {
    const state = get();
    const entry = state.history.at(-1);
    if (!entry) return;
    set({
      nodes: entry.nodes,
      viewportOffset: entry.viewportOffset,
      zoomLevel: entry.zoomLevel,
      focusedNodeId: entry.focusedNodeId,
      selectedNodeId: entry.selectedNodeId,
      history: state.history.slice(0, -1),
    });
  },
});
