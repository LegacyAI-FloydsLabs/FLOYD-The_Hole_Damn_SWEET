// CURSE'M IDE — canvas selection slice.
//
// Selection is the keyboard-navigation cursor: it marks a node without
// stealing keyboard focus, so chained Cmd+Arrow presses keep working.

import type { StateCreator } from 'zustand';
import type { CanvasStoreState } from '../state';

export const createSelectionSlice: StateCreator<CanvasStoreState, [], [], Partial<CanvasStoreState>> = (set) => ({
  selectNode: (nodeId) => set((state) => {
    if (nodeId !== null && !state.nodes[nodeId]) return state;
    return { selectedNodeId: nodeId };
  }),
});
