import { beforeEach, describe, expect, it } from 'vitest';
import { createCanvasStore, selectVisibleNodeIds, type CanvasStore } from '@/canvas/canvasStore';
import { findNodeInDirection, PAN_STEP } from '@/canvas/helpers';
import { ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN, type CanvasNodeState } from '@/canvas/types';
import type { PanelState } from '@/panels/types';
import { useUIStore, DEFAULT_PREFERENCES } from '@/store/uiStore';

const panel = (id: string): PanelState => ({ id, type: 'editor', title: id });

const node = (id: string, x: number, y: number, creationIndex = 0): CanvasNodeState => ({
  id,
  panel: panel(`panel-${id}`),
  origin: { x, y },
  size: { width: 100, height: 100 },
  zOrder: 1,
  creationIndex,
});

function makeStore(): CanvasStore {
  const store = createCanvasStore();
  store.getState().setContainerSize({ width: 1000, height: 800 });
  return store;
}

describe('canvas store', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reduced motion collapses viewport glides to instant jumps, so nav and
    // pan assertions can read the final offset synchronously.
    useUIStore.setState({ preferences: { ...DEFAULT_PREFERENCES, reducedMotion: true } });
  });

  it('addNode defaults to viewport-center placement', () => {
    const store = makeStore();
    const id = store.getState().addNode(panel('p1'));
    const state = store.getState();
    const placed = state.nodes[id];
    expect(placed.origin.x + placed.size.width / 2).toBeCloseTo(500, -1);
    expect(placed.origin.y + placed.size.height / 2).toBeCloseTo(400, -1);
    expect(state.focusedNodeId).toBe(id);
  });

  it('clamps zoom to the 0.3–3.0 range', () => {
    const store = makeStore();
    store.getState().zoomAtScreenPoint({ x: 0, y: 0 }, 100);
    expect(store.getState().zoomLevel).toBe(ZOOM_MAX);
    store.getState().zoomAtScreenPoint({ x: 0, y: 0 }, 0.0001);
    expect(store.getState().zoomLevel).toBe(ZOOM_MIN);
    store.getState().setViewport({ x: 0, y: 0 }, ZOOM_DEFAULT);
    expect(store.getState().zoomLevel).toBe(ZOOM_DEFAULT);
  });

  it('zoom-around-cursor keeps the cursor world point pinned', () => {
    const store = makeStore();
    const cursor = { x: 250, y: 200 };
    const before = store.getState();
    const worldX = (cursor.x - before.viewportOffset.x) / before.zoomLevel;
    store.getState().zoomAtScreenPoint(cursor, 1.5);
    const after = store.getState();
    const worldXAfter = (cursor.x - after.viewportOffset.x) / after.zoomLevel;
    expect(worldXAfter).toBeCloseTo(worldX);
  });

  it('findNodeInDirection scores nearest-ahead over far-aligned', () => {
    const origin = node('origin', 0, 0);
    const candidates = [
      node('far-right-aligned', 2000, 0),
      node('near-right-offset', 300, 60),
      node('behind', -500, 0),
    ];
    const found = findNodeInDirection([origin, ...candidates], { x: 50, y: 50 }, 'right', 'origin');
    expect(found?.id).toBe('near-right-offset');
  });

  it('navigateSelect moves the selection cursor without focusing', () => {
    const store = makeStore();
    const a = store.getState().addNode(panel('p1'), { x: 0, y: 0 }, { width: 100, height: 100 });
    const b = store.getState().addNode(panel('p2'), { x: 600, y: 0 }, { width: 100, height: 100 });
    store.getState().focusNode(a);
    store.getState().navigateSelect('right');
    const state = store.getState();
    expect(state.selectedNodeId).toBe(b);
    // Selection is not focus — navigation never grabbed keyboard focus.
    expect(state.focusedNodeId).toBe(a);
    // Viewport glided to center the selected node (instant under reduced motion).
    const placed = state.nodes[b];
    const centerScreenX = state.viewportOffset.x + (placed.origin.x + placed.size.width / 2) * state.zoomLevel;
    expect(centerScreenX).toBeCloseTo(state.containerSize.width / 2);
  });

  it('panViewport pans by PAN_STEP in the pressed direction', () => {
    const store = makeStore();
    store.getState().panViewport('right');
    expect(store.getState().viewportOffset.x).toBe(-PAN_STEP);
    store.getState().panViewport('down');
    expect(store.getState().viewportOffset.y).toBe(-PAN_STEP);
  });

  it('autoLayout reflows into a grid and is undoable via history', () => {
    const store = makeStore();
    store.getState().addNode(panel('p1'), { x: 11, y: 13 }, { width: 100, height: 100 });
    store.getState().addNode(panel('p2'), { x: 500, y: 700 }, { width: 100, height: 100 });
    const before = store.getState().nodes;
    store.getState().autoLayout();
    const after = store.getState();
    expect(after.history).toHaveLength(1);
    const [first, second] = Object.values(after.nodes).sort((x, y) => x.creationIndex - y.creationIndex);
    expect(first.origin.y).toBeCloseTo(second.origin.y, 0); // same row
    expect(second.origin.x).toBeGreaterThan(first.origin.x);
    store.getState().undoLayout();
    expect(store.getState().nodes).toEqual(before);
  });

  it('culls off-screen nodes but keeps focused/pinned mounted', () => {
    const store = makeStore();
    const near = store.getState().addNode(panel('p1'), { x: 0, y: 0 }, { width: 100, height: 100 });
    const far = store.getState().addNode(panel('p2'), { x: 100000, y: 100000 }, { width: 100, height: 100 });
    let visible = selectVisibleNodeIds(store.getState());
    expect(visible).toContain(near);
    expect(visible).toContain(far); // focused → exempt from culling
    store.getState().focusNode(near);
    visible = selectVisibleNodeIds(store.getState());
    expect(visible).toEqual([near]);
    store.getState().pinNode(far, true);
    visible = selectVisibleNodeIds(store.getState());
    expect(visible).toContain(far); // pinned → exempt
  });
});
