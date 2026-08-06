// CURSE'M IDE — canvas shared types & constants.
//
// The canvas is an infinite 2D world surface. Node geometry lives in world
// coordinates; the viewport is `{ viewportOffset, zoomLevel }` such that
//   screen = viewportOffset + world * zoomLevel.
// Ported in shape from Cate's canvas store (see feature-map canvas-docking
// §Workflow 1) onto CURSEM's Zustand substrate.

import type { PanelState } from '@/panels/types';

export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 3.0;
export const ZOOM_DEFAULT = 1.0;

/** World-space grid nodes snap to when moved/resized. */
export const CANVAS_GRID_SIZE = 20;

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface CanvasNodeState {
  id: string;
  /** The panel this node hosts (one panel per node in this build; per-node
   *  mini-docks arrive with the nested-canvas phase). */
  panel: PanelState;
  origin: Point;
  size: Size;
  zOrder: number;
  creationIndex: number;
  /** Pinned nodes are exempt from viewport culling. */
  isPinned?: boolean;
}

export type NavDirection = 'up' | 'down' | 'left' | 'right';

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

export function viewToCanvas(point: Point, offset: Point, zoom: number): Point {
  return { x: (point.x - offset.x) / zoom, y: (point.y - offset.y) / zoom };
}

export function canvasToView(point: Point, offset: Point, zoom: number): Point {
  return { x: offset.x + point.x * zoom, y: offset.y + point.y * zoom };
}

export function snapToGrid(value: number): number {
  return Math.round(value / CANVAS_GRID_SIZE) * CANVAS_GRID_SIZE;
}
