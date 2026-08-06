// CURSE'M IDE — canvas view.
//
// The infinite pan/zoom surface (feature-map §Workflow 1). Key properties:
//   - overflow: clip container — it can never become a scroll container.
//   - The world layer is transformed IMPERATIVELY on store subscribe, so
//     pan/zoom gestures never re-render React.
//   - Screen-space grid (CanvasGrid) lives outside the world transform and
//     is repositioned in the same subscribe tick, so lines stay on whole
//     device pixels.
//   - Wheel zooms around the cursor ({ passive: false }); wheel over panel
//     content scrolls that content unless Ctrl/Cmd is held (Monaco/xterm
//     keep their scroll — Cate zooms everywhere, but its Electron webviews
//     don't host nested scrollers the way CURSEM's in-DOM panels do).
//   - Drag empty canvas to pan; click empty canvas to unfocus.
//   - File drops from the internal FileTree spawn an editor at the drop
//     point; OS drops are ignored (browser File objects carry no path).
//   - Viewport culling: only nodes near the viewport mount (focused/pinned
//     exempt) — see selectVisibleNodeIds.

import { useEffect, useRef, useSyncExternalStore, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from 'zustand';
import type { PanelComponentProps } from '@/panels/registry';
import { handleCanvasFileDrop } from '@/panels/panelOps';
import { FILE_DRAG_MIME } from '@/panels/dragTypes';
import { Icon } from '@/components/Icon';
import { getOrCreateCanvasStoreForPanel } from './canvasRegistry';
import { selectVisibleNodeIds, visibleNodeIdsEqual, type CanvasStore } from './canvasStore';
import { snapToGrid, viewToCanvas } from './types';

/** Visible-node ids with reference stability: React only re-renders when the
 *  culled id set actually changes, while the world transform streams
 *  imperatively at gesture frequency. (zustand/traditional would need the
 *  use-sync-external-store package — not a dependency here.) */
function useVisibleNodeIds(store: CanvasStore): string[] {
  const cacheRef = useRef<string[] | null>(null);
  return useSyncExternalStore(store.subscribe, () => {
    const ids = selectVisibleNodeIds(store.getState());
    if (cacheRef.current && visibleNodeIdsEqual(cacheRef.current, ids)) return cacheRef.current;
    cacheRef.current = ids;
    return ids;
  });
}
import { CanvasGrid } from './CanvasGrid';
import { CanvasNode } from './CanvasNode';

export const CANVAS_INTERACTING_CLASS = 'cursem-canvas-interacting';

// Interaction CSS, injected once at module level: while a pan/zoom/node
// gesture runs, panel content (Monaco, xterm, iframes) must not swallow
// pointer events.
const INTERACTION_STYLE_ID = 'cursem-canvas-interaction-css';
function ensureInteractionCss(): void {
  if (document.getElementById(INTERACTION_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = INTERACTION_STYLE_ID;
  style.textContent = `
    body.${CANVAS_INTERACTING_CLASS} .monaco-editor,
    body.${CANVAS_INTERACTING_CLASS} .xterm,
    body.${CANVAS_INTERACTING_CLASS} iframe { pointer-events: none !important; }
    body.${CANVAS_INTERACTING_CLASS} { cursor: grabbing; }
  `;
  document.head.appendChild(style);
}

export function setCanvasInteracting(active: boolean): void {
  document.body.classList.toggle(CANVAS_INTERACTING_CLASS, active);
}

export function CanvasView({ panel }: PanelComponentProps) {
  const store = getOrCreateCanvasStoreForPanel(panel.id);
  const containerRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ pointerId: number; lastX: number; lastY: number; moved: boolean } | null>(null);
  const gestureTimerRef = useRef<number | null>(null);

  const visibleIds = useVisibleNodeIds(store);
  const nodeCount = useStore(store, (state) => Object.keys(state.nodes).length);

  // Imperative world transform + grid sync — the per-frame path.
  useEffect(() => {
    ensureInteractionCss();
    const apply = () => {
      const state = store.getState();
      if (worldRef.current) {
        worldRef.current.style.transform =
          `translate(${state.viewportOffset.x}px, ${state.viewportOffset.y}px) scale(${state.zoomLevel})`;
      }
      if (gridRef.current) {
        const spacing = 20 * state.zoomLevel;
        gridRef.current.style.backgroundSize = `${spacing}px ${spacing}px`;
        gridRef.current.style.backgroundPosition = `${state.viewportOffset.x}px ${state.viewportOffset.y}px`;
      }
    };
    apply();
    return store.subscribe(apply);
  }, [store]);

  // Container size feeds culling, navigation, and auto-layout.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const publish = () => store.getState().setContainerSize({ width: element.clientWidth, height: element.clientHeight });
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => observer.disconnect();
  }, [store]);

  // will-change promotion during gestures, de-promoted 150ms after settle.
  const markGesture = () => {
    containerRef.current?.classList.add('gesturing');
    if (gestureTimerRef.current !== null) window.clearTimeout(gestureTimerRef.current);
    gestureTimerRef.current = window.setTimeout(() => {
      containerRef.current?.classList.remove('gesturing');
      gestureTimerRef.current = null;
    }, 150);
  };

  // Wheel zoom around the cursor — non-passive so preventDefault works.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null;
      const overContent = !!target?.closest?.('.canvas-node-body');
      if (overContent && !event.ctrlKey && !event.metaKey) return; // panel content scrolls
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * 0.0022);
      store.getState().zoomAtScreenPoint({ x: event.clientX - rect.left, y: event.clientY - rect.top }, factor);
      markGesture();
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('.canvas-node')) return; // nodes handle their own gestures
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    containerRef.current?.setPointerCapture(event.pointerId);
    panRef.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY, moved: false };
    setCanvasInteracting(true);
    markGesture();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    const dx = event.clientX - pan.lastX;
    const dy = event.clientY - pan.lastY;
    if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
    pan.lastX = event.clientX;
    pan.lastY = event.clientY;
    store.getState().panByScreenDelta(dx, dy);
    markGesture();
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    panRef.current = null;
    setCanvasInteracting(false);
    markGesture();
    if (!pan.moved) {
      // Click on empty canvas: unfocus and clear the selection cursor.
      store.getState().focusNode(null);
      store.getState().selectNode(null);
    }
  };

  const onDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes(FILE_DRAG_MIME)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  };

  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    const path = event.dataTransfer.getData(FILE_DRAG_MIME);
    if (!path) return; // OS drops: ignored (browser Files carry no usable path)
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const state = store.getState();
    const worldPoint = viewToCanvas(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      state.viewportOffset,
      state.zoomLevel,
    );
    handleCanvasFileDrop(path, {
      x: snapToGrid(worldPoint.x),
      y: snapToGrid(worldPoint.y),
    });
  };

  return (
    <div
      ref={containerRef}
      className="canvas-viewport"
      data-canvas-panel={panel.id}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <CanvasGrid ref={gridRef} />
      <div ref={worldRef} className="canvas-world">
        {visibleIds.map((nodeId) => <CanvasNode key={nodeId} nodeId={nodeId} store={store} />)}
      </div>
      {nodeCount === 0 && (
        <div className="canvas-empty-hint">
          <Icon name="files" size={22} />
          <span>Open a file, drop it here, or run “Canvas: New Editor at Center”.</span>
        </div>
      )}
    </div>
  );
}
