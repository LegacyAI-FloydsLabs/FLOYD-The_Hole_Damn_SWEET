// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resizeNodeRect, MIN_NODE_WIDTH, MIN_NODE_HEIGHT } from '@/canvas/helpers';
import { CANVAS_GRID_SIZE } from '@/canvas/types';

const start = { origin: { x: 100, y: 100 }, size: { width: 400, height: 300 } };

describe('canvas node edge/corner resize', () => {
  it('e edge grows only the width, origin untouched', () => {
    const next = resizeNodeRect(start, 'e', 55, 40);
    expect(next.origin).toEqual(start.origin);
    expect(next.size.width).toBe(460); // 400 + 55 snapped to grid 20
    expect(next.size.height).toBe(300);
  });

  it('s edge grows only the height, origin untouched', () => {
    const next = resizeNodeRect(start, 's', 55, 47);
    expect(next.origin).toEqual(start.origin);
    expect(next.size).toEqual({ width: 400, height: 340 });
  });

  it('se corner grows both axes', () => {
    const next = resizeNodeRect(start, 'se', 21, 19);
    expect(next.origin).toEqual(start.origin);
    expect(next.size).toEqual({ width: 420, height: 320 });
  });

  it('w edge moves the origin with the drag so the right edge stays fixed', () => {
    const next = resizeNodeRect(start, 'w', -60, 25);
    // dragging the left edge leftward by 60: origin.x 40, width 460, right edge 500 preserved
    expect(next.origin).toEqual({ x: 40, y: 100 });
    expect(next.size.width).toBe(460);
    expect(next.origin.x + next.size.width).toBe(start.origin.x + start.size.width);
    expect(next.size.height).toBe(300);
  });

  it('n edge moves the origin with the drag so the bottom edge stays fixed', () => {
    const next = resizeNodeRect(start, 'n', 25, -40);
    expect(next.origin).toEqual({ x: 100, y: 60 });
    expect(next.size.height).toBe(340);
    expect(next.origin.y + next.size.height).toBe(start.origin.y + start.size.height);
    expect(next.size.width).toBe(400);
  });

  it('nw corner moves both origin axes and keeps the far corner fixed', () => {
    const next = resizeNodeRect(start, 'nw', -20, -20);
    expect(next.origin).toEqual({ x: 80, y: 80 });
    expect(next.size).toEqual({ width: 420, height: 320 });
    expect(next.origin.x + next.size.width).toBe(500);
    expect(next.origin.y + next.size.height).toBe(400);
  });

  it('clamps to the minimum size without drifting the anchored edge', () => {
    const east = resizeNodeRect(start, 'e', -9999, 0);
    expect(east.size.width).toBe(MIN_NODE_WIDTH);
    expect(east.origin).toEqual(start.origin);

    const west = resizeNodeRect(start, 'w', 9999, 0);
    expect(west.size.width).toBe(MIN_NODE_WIDTH);
    // right edge anchored even at the clamp
    expect(west.origin.x + west.size.width).toBe(start.origin.x + start.size.width);

    const north = resizeNodeRect(start, 'n', 0, 9999);
    expect(north.size.height).toBe(MIN_NODE_HEIGHT);
    expect(north.origin.y + north.size.height).toBe(start.origin.y + start.size.height);
  });

  it('snaps every resulting coordinate to the canvas grid', () => {
    for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const) {
      const next = resizeNodeRect(start, edge, 37, -23);
      expect(next.origin.x % CANVAS_GRID_SIZE).toBe(0);
      expect(next.origin.y % CANVAS_GRID_SIZE).toBe(0);
      expect(next.size.width % CANVAS_GRID_SIZE).toBe(0);
      expect(next.size.height % CANVAS_GRID_SIZE).toBe(0);
    }
  });
});
