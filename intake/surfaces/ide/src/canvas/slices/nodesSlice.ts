// CURSE'M IDE — canvas nodes slice.
//
// Node CRUD + focus/z-order. addNode defaults to viewport-center placement
// (the placement-ghost picker is deferred; creation lands in the middle of
// what the user is looking at, snapped to the canvas grid).

import type { StateCreator } from 'zustand';
import type { CanvasStoreState } from '../state';
import { snapToGrid, type CanvasNodeState } from '../types';

// Sized so the seeded editor node fits the WelcomeScreen (mark + preflight
// grid + action rows ≈ 600px tall) without clipping at default zoom.
const DEFAULT_NODE_SIZE = { width: 760, height: 640 };

export const createNodesSlice: StateCreator<CanvasStoreState, [], [], Partial<CanvasStoreState>> = (set, get) => ({
  addNode: (panel, origin, size) => {
    const state = get();
    const nodeSize = size ?? DEFAULT_NODE_SIZE;
    // Viewport center in world coordinates, minus half the node, grid-snapped.
    const centerX = (state.containerSize.width / 2 - state.viewportOffset.x) / state.zoomLevel;
    const centerY = (state.containerSize.height / 2 - state.viewportOffset.y) / state.zoomLevel;
    const nodeOrigin = origin ?? {
      x: snapToGrid(centerX - nodeSize.width / 2),
      y: snapToGrid(centerY - nodeSize.height / 2),
    };
    const id = `node-${state.nextNodeSeq}`;
    const node: CanvasNodeState = {
      id,
      panel,
      origin: nodeOrigin,
      size: nodeSize,
      zOrder: state.nextZOrder,
      creationIndex: state.nextCreationIndex,
    };
    set({
      nodes: { ...state.nodes, [id]: node },
      nextZOrder: state.nextZOrder + 1,
      nextCreationIndex: state.nextCreationIndex + 1,
      nextNodeSeq: state.nextNodeSeq + 1,
      focusedNodeId: id,
      selectedNodeId: id,
    });
    return id;
  },

  removeNode: (nodeId) => set((state) => {
    if (!state.nodes[nodeId]) return state;
    const nodes = { ...state.nodes };
    delete nodes[nodeId];
    return {
      nodes,
      focusedNodeId: state.focusedNodeId === nodeId ? null : state.focusedNodeId,
      selectedNodeId: state.selectedNodeId === nodeId ? null : state.selectedNodeId,
    };
  }),

  setNodeOrigin: (nodeId, origin) => set((state) => {
    const node = state.nodes[nodeId];
    if (!node) return state;
    return { nodes: { ...state.nodes, [nodeId]: { ...node, origin } } };
  }),

  setNodeSize: (nodeId, size) => set((state) => {
    const node = state.nodes[nodeId];
    if (!node) return state;
    return { nodes: { ...state.nodes, [nodeId]: { ...node, size } } };
  }),

  focusNode: (nodeId) => set((state) => {
    if (nodeId !== null && !state.nodes[nodeId]) return state;
    const patch: Partial<CanvasStoreState> = { focusedNodeId: nodeId, selectedNodeId: nodeId };
    if (nodeId) {
      const node = state.nodes[nodeId];
      patch.nodes = { ...state.nodes, [nodeId]: { ...node, zOrder: state.nextZOrder } };
      patch.nextZOrder = state.nextZOrder + 1;
    }
    return patch;
  }),

  bringToFront: (nodeId) => set((state) => {
    const node = state.nodes[nodeId];
    if (!node || node.zOrder === state.nextZOrder - 1) return state;
    return {
      nodes: { ...state.nodes, [nodeId]: { ...node, zOrder: state.nextZOrder } },
      nextZOrder: state.nextZOrder + 1,
    };
  }),

  pinNode: (nodeId, pinned) => set((state) => {
    const node = state.nodes[nodeId];
    if (!node) return state;
    return { nodes: { ...state.nodes, [nodeId]: { ...node, isPinned: pinned } } };
  }),
});
