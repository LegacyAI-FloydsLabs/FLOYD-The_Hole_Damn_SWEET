// CURSE'M IDE — canvas store state contract.
//
// Shared state shape for the per-surface canvas stores. Slices
// (src/canvas/slices/*) implement the actions; canvasStore.ts composes them
// into the createCanvasStore() factory. Kept separate so slices and the
// factory never import each other at runtime.

import type { PanelState } from '@/panels/types';
import type { CanvasNodeState, NavDirection, Point, Size } from './types';

export interface CanvasHistoryEntry {
  nodes: Record<string, CanvasNodeState>;
  viewportOffset: Point;
  zoomLevel: number;
  focusedNodeId: string | null;
  selectedNodeId: string | null;
}

export interface CanvasStoreState {
  nodes: Record<string, CanvasNodeState>;
  viewportOffset: Point;
  zoomLevel: number;
  /** Viewport size in screen px, fed by CanvasView's ResizeObserver. */
  containerSize: Size;
  focusedNodeId: string | null;
  selectedNodeId: string | null;
  /** Layout undo stack (auto-layout and future arrange ops push here). */
  history: CanvasHistoryEntry[];
  nextZOrder: number;
  nextCreationIndex: number;
  nextNodeSeq: number;

  // nodes slice
  addNode: (panel: PanelState, origin?: Point, size?: Size) => string;
  removeNode: (nodeId: string) => void;
  setNodeOrigin: (nodeId: string, origin: Point) => void;
  setNodeSize: (nodeId: string, size: Size) => void;
  focusNode: (nodeId: string | null) => void;
  bringToFront: (nodeId: string) => void;
  pinNode: (nodeId: string, pinned: boolean) => void;

  // viewport slice
  setViewport: (offset: Point, zoom?: number) => void;
  setContainerSize: (size: Size) => void;
  zoomAtScreenPoint: (screenPoint: Point, factor: number) => void;
  panByScreenDelta: (dx: number, dy: number) => void;
  /** Animated viewport move; repeated calls accumulate onto the in-flight
   *  target so chained keyboard nav glides smoothly. */
  glideTo: (offset: Point, zoom?: number) => void;
  zoomToFit: () => void;

  // selection slice
  selectNode: (nodeId: string | null) => void;

  // navigation slice
  navigateSelect: (direction: NavDirection) => void;
  panViewport: (direction: NavDirection) => void;

  // arrange slice
  autoLayout: () => void;

  // history slice
  pushHistory: () => void;
  undoLayout: () => void;
}
