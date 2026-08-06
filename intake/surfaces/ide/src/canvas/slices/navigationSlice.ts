// CURSE'M IDE — canvas navigation slice.
//
// Spatial keyboard navigation (feature-map §Workflow 7):
//   Cmd+Arrow   → navigateSelect — selection cursor jumps to the nearest
//                 node in that direction; viewport glides to center it.
//                 Selection never grabs keyboard focus, so arrows chain.
//   Shift+Arrow → panViewport — viewport pans by PAN_STEP, accumulating
//                 from the in-flight glide target.
// Reference point = selected node center, else focused node center, else
// viewport center.

import type { StateCreator } from 'zustand';
import type { CanvasStoreState } from '../state';
import { findNodeInDirection, nodeCenter, PAN_STEP } from '../helpers';
import type { Point } from '../types';

export const createNavigationSlice: StateCreator<CanvasStoreState, [], [], Partial<CanvasStoreState>> = (set, get) => ({
  navigateSelect: (direction) => {
    const state = get();
    const nodes = Object.values(state.nodes);
    if (nodes.length === 0) return;
    const reference: Point = state.selectedNodeId && state.nodes[state.selectedNodeId]
      ? nodeCenter(state.nodes[state.selectedNodeId])
      : state.focusedNodeId && state.nodes[state.focusedNodeId]
        ? nodeCenter(state.nodes[state.focusedNodeId])
        : {
            x: (state.containerSize.width / 2 - state.viewportOffset.x) / state.zoomLevel,
            y: (state.containerSize.height / 2 - state.viewportOffset.y) / state.zoomLevel,
          };
    const target = findNodeInDirection(nodes, reference, direction, state.selectedNodeId);
    if (!target) return;
    // Select only — no focusNode(), so keyboard focus stays put.
    set({ selectedNodeId: target.id });
    const center = nodeCenter(target);
    get().glideTo({
      x: state.containerSize.width / 2 - center.x * state.zoomLevel,
      y: state.containerSize.height / 2 - center.y * state.zoomLevel,
    });
  },

  panViewport: (direction) => {
    const { viewportOffset } = get();
    const delta: Point = {
      up: { x: 0, y: PAN_STEP },
      down: { x: 0, y: -PAN_STEP },
      left: { x: PAN_STEP, y: 0 },
      right: { x: -PAN_STEP, y: 0 },
    }[direction];
    get().glideTo({ x: viewportOffset.x + delta.x, y: viewportOffset.y + delta.y });
  },
});
