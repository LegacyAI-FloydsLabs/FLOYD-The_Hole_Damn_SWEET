// CURSE'M IDE — canvas viewport slice.
//
// Pan/zoom primitives. The world transform is applied imperatively by
// CanvasView on store subscribe, so these setters run at gesture frequency
// without re-rendering React. glideTo tweens the viewport over ~160ms;
// repeated calls re-target the in-flight animation from its current target
// so chained keyboard navigation accumulates smoothly. Reduced-motion
// preference collapses the tween to an instant jump.

import type { StateCreator } from 'zustand';
import type { CanvasStoreState } from '../state';
import { clampZoom, ZOOM_DEFAULT, type Point } from '../types';
import { nodesBoundingBox } from '../helpers';
import { useUIStore } from '@/store/uiStore';

const GLIDE_MS = 160;

export const createViewportSlice: StateCreator<CanvasStoreState, [], [], Partial<CanvasStoreState>> = (set, get) => {
  let glideFrame: number | null = null;
  let glideTarget: { offset: Point; zoom: number } | null = null;

  const stopGlide = () => {
    if (glideFrame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(glideFrame);
    glideFrame = null;
    glideTarget = null;
  };

  return {
    setViewport: (offset, zoom) => {
      stopGlide();
      set({ viewportOffset: offset, ...(zoom !== undefined ? { zoomLevel: clampZoom(zoom) } : {}) });
    },

    setContainerSize: (size) => set({ containerSize: size }),

    zoomAtScreenPoint: (screenPoint, factor) => {
      const { viewportOffset, zoomLevel } = get();
      const zoom = clampZoom(zoomLevel * factor);
      if (zoom === zoomLevel) return;
      // Keep the cursor's world point pinned: screen = offset + world * zoom.
      const scale = zoom / zoomLevel;
      set({
        zoomLevel: zoom,
        viewportOffset: {
          x: screenPoint.x - (screenPoint.x - viewportOffset.x) * scale,
          y: screenPoint.y - (screenPoint.y - viewportOffset.y) * scale,
        },
      });
    },

    panByScreenDelta: (dx, dy) => {
      stopGlide();
      const { viewportOffset } = get();
      set({ viewportOffset: { x: viewportOffset.x + dx, y: viewportOffset.y + dy } });
    },

    glideTo: (offset, zoom) => {
      const state = get();
      const target = { offset, zoom: clampZoom(zoom ?? state.zoomLevel) };
      if (useUIStore.getState().preferences.reducedMotion || typeof requestAnimationFrame !== 'function') {
        stopGlide();
        set({ viewportOffset: target.offset, zoomLevel: target.zoom });
        return;
      }
      // Accumulate from the in-flight target, tween from the live position.
      glideTarget = target;
      const startOffset = { ...state.viewportOffset };
      const startZoom = state.zoomLevel;
      const startedAt = performance.now();
      if (glideFrame !== null) cancelAnimationFrame(glideFrame);
      const step = (now: number) => {
        const active = glideTarget;
        if (!active) return;
        const t = Math.min(1, (now - startedAt) / GLIDE_MS);
        const eased = 1 - (1 - t) * (1 - t);
        set({
          viewportOffset: {
            x: startOffset.x + (active.offset.x - startOffset.x) * eased,
            y: startOffset.y + (active.offset.y - startOffset.y) * eased,
          },
          zoomLevel: startZoom + (active.zoom - startZoom) * eased,
        });
        if (t < 1) {
          glideFrame = requestAnimationFrame(step);
        } else {
          glideFrame = null;
          glideTarget = null;
        }
      };
      glideFrame = requestAnimationFrame(step);
    },

    zoomToFit: () => {
      const state = get();
      const bounds = nodesBoundingBox(Object.values(state.nodes));
      if (!bounds) {
        get().glideTo(state.viewportOffset, ZOOM_DEFAULT);
        return;
      }
      const { width, height } = state.containerSize;
      if (width <= 0 || height <= 0 || bounds.width <= 0 || bounds.height <= 0) return;
      const zoom = clampZoom(Math.min(width / bounds.width, height / bounds.height) * 0.9);
      get().glideTo({
        x: width / 2 - (bounds.x + bounds.width / 2) * zoom,
        y: height / 2 - (bounds.y + bounds.height / 2) * zoom,
      }, zoom);
    },
  };
};
