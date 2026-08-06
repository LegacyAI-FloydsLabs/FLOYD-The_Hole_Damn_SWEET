// CURSE'M IDE — canvas spatial helpers.
//
// Directional navigation scoring (Cate's findNodeInDirection) and the
// keyboard pan step. Pure functions — unit-tested directly.

import type { CanvasNodeState, NavDirection, Point } from './types';

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
