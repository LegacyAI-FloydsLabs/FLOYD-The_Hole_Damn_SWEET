// CURSE'M IDE — canvas spatial helpers.
//
// Directional navigation scoring (Cate's findNodeInDirection) and the
// keyboard pan step. Pure functions — unit-tested directly.

import { snapToGrid, type CanvasNodeState, type NavDirection, type Point } from './types';

/** Smallest canvas node footprint (world px). Exported for CanvasNode + tests. */
export const MIN_NODE_WIDTH = 240;
export const MIN_NODE_HEIGHT = 160;

/** Edges/corners a node can be resized from. */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export interface NodeRect {
  origin: Point;
  size: { width: number; height: number };
}

/**
 * Pure edge/corner resize math for canvas nodes. `dx`/`dy` are world-space
 * drag deltas (caller divides screen delta by zoom). West/north handles move
 * the origin with the pointer so the opposite edge stays anchored; clamps
 * keep the anchor fixed instead of letting the node drift. Every output
 * coordinate is grid-snapped.
 */
export function resizeNodeRect(start: NodeRect, edge: ResizeEdge, dx: number, dy: number): NodeRect {
  const left = start.origin.x;
  const top = start.origin.y;
  const right = left + start.size.width;
  const bottom = top + start.size.height;

  let newLeft = left;
  let newTop = top;
  let newRight = right;
  let newBottom = bottom;

  if (edge.includes('w')) newLeft = Math.min(left + dx, right - MIN_NODE_WIDTH);
  if (edge.includes('e')) newRight = Math.max(right + dx, left + MIN_NODE_WIDTH);
  if (edge.includes('n')) newTop = Math.min(top + dy, bottom - MIN_NODE_HEIGHT);
  if (edge.includes('s')) newBottom = Math.max(bottom + dy, top + MIN_NODE_HEIGHT);

  return {
    origin: { x: snapToGrid(newLeft), y: snapToGrid(newTop) },
    size: {
      width: Math.max(MIN_NODE_WIDTH, snapToGrid(newRight - newLeft)),
      height: Math.max(MIN_NODE_HEIGHT, snapToGrid(newBottom - newTop)),
    },
  };
}

/** Screen pixels the viewport pans per Shift+Arrow press. */
export const PAN_STEP = 240;

const DIRECTION_VECTORS: Record<NavDirection, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export function nodeCenter(node: CanvasNodeState): Point {
  return { x: node.origin.x + node.size.width / 2, y: node.origin.y + node.size.height / 2 };
}

/**
 * Nearest node in a direction from a reference point. Candidates must lie in
 * the direction's half-plane; scoring is primary-axis distance plus a
 * penalized orthogonal component so "roughly ahead" beats "far but exactly
 * aligned". Returns null when nothing lies that way.
 */
export function findNodeInDirection(
  nodes: CanvasNodeState[],
  from: Point,
  direction: NavDirection,
  excludeId?: string | null,
): CanvasNodeState | null {
  const vector = DIRECTION_VECTORS[direction];
  let best: CanvasNodeState | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    if (node.id === excludeId) continue;
    const center = nodeCenter(node);
    const dx = center.x - from.x;
    const dy = center.y - from.y;
    const primary = dx * vector.x + dy * vector.y;
    if (primary <= 1) continue;
    const orthogonal = Math.abs(vector.x === 0 ? dx : dy);
    const score = primary + orthogonal * 2;
    if (score < bestScore) {
      bestScore = score;
      best = node;
    }
  }
  return best;
}

/** World-space rect of the union of all nodes (null when empty). */
export function nodesBoundingBox(nodes: CanvasNodeState[]): { x: number; y: number; width: number; height: number } | null {
  if (nodes.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.origin.x);
    minY = Math.min(minY, node.origin.y);
    maxX = Math.max(maxX, node.origin.x + node.size.width);
    maxY = Math.max(maxY, node.origin.y + node.size.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
