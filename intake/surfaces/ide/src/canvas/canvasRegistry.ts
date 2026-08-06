// CURSE'M IDE — canvas store registry.
//
// One canvas store per canvas panel id. The primary workspace canvas lives
// in the dock's center zone as the 'canvas' panel; getPrimaryCanvasStore()
// is how shell-level features (keyboard nav, command palette, panel ops)
// reach it without prop drilling.

import { panelIdForType } from '@/panels/types';
import { createCanvasStore, type CanvasStore } from './canvasStore';

export const PRIMARY_CANVAS_PANEL_ID = panelIdForType('canvas');

const stores = new Map<string, CanvasStore>();

export function getOrCreateCanvasStoreForPanel(panelId: string): CanvasStore {
  let store = stores.get(panelId);
  if (!store) {
    store = createCanvasStore();
    stores.set(panelId, store);
  }
  return store;
}

export function getPrimaryCanvasStore(): CanvasStore {
  return getOrCreateCanvasStoreForPanel(PRIMARY_CANVAS_PANEL_ID);
}

/** Test support: drop every registered store. */
export function resetCanvasRegistry(): void {
  stores.clear();
}
