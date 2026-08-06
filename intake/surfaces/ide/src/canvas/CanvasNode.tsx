// CURSE'M IDE — canvas node.
//
// One spatial node = title bar + a PanelHost. Title-bar drag moves the node
// (grid-snapped), any edge or corner resizes it (grid-snapped, opposite edge
// anchored), the close button removes it
// (the panel becomes unplaced and can be re-docked from the activity bar or
// command palette). Pointer-down anywhere on the node focuses/raises it —
// before Monaco or xterm see the event, but without preventing default, so
// the editor still takes keyboard focus.

import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from 'zustand';
import { PanelHost } from '@/panels/PanelHost';
import { getPanelTitle } from '@/panels/registry';
import { Icon } from '@/components/Icon';
import type { CanvasStore } from './canvasStore';
import { setCanvasInteracting } from './CanvasView';
import { resizeNodeRect, type NodeRect, type ResizeEdge } from './helpers';
import { snapToGrid } from './types';

const RESIZE_EDGES: ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

export function CanvasNode({ nodeId, store }: { nodeId: string; store: CanvasStore }) {
  const node = useStore(store, (state) => state.nodes[nodeId]);
  const focused = useStore(store, (state) => state.focusedNodeId === nodeId);
  const selected = useStore(store, (state) => state.selectedNodeId === nodeId);
  const moveRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const resizeRef = useRef<{ pointerId: number; edge: ResizeEdge; startX: number; startY: number; rect: NodeRect } | null>(null);

  if (!node) return null;

  const onTitlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    moveRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: node.origin.x,
      originY: node.origin.y,
    };
    setCanvasInteracting(true);
  };

  const onTitlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = moveRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const { zoomLevel } = store.getState();
    store.getState().setNodeOrigin(nodeId, {
      x: snapToGrid(drag.originX + (event.clientX - drag.startX) / zoomLevel),
      y: snapToGrid(drag.originY + (event.clientY - drag.startY) / zoomLevel),
    });
  };

  const onTitlePointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (moveRef.current?.pointerId !== event.pointerId) return;
    moveRef.current = null;
    setCanvasInteracting(false);
  };

  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const edge = event.currentTarget.dataset.edge as ResizeEdge | undefined;
    if (!edge) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = {
      pointerId: event.pointerId,
      edge,
      startX: event.clientX,
      startY: event.clientY,
      rect: { origin: { ...node.origin }, size: { ...node.size } },
    };
    setCanvasInteracting(true);
  };

  const onResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const { zoomLevel } = store.getState();
    const next = resizeNodeRect(
      drag.rect,
      drag.edge,
      (event.clientX - drag.startX) / zoomLevel,
      (event.clientY - drag.startY) / zoomLevel,
    );
    if (next.origin.x !== node.origin.x || next.origin.y !== node.origin.y) {
      store.getState().setNodeOrigin(nodeId, next.origin);
    }
    if (next.size.width !== node.size.width || next.size.height !== node.size.height) {
      store.getState().setNodeSize(nodeId, next.size);
    }
  };

  const onResizePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    setCanvasInteracting(false);
  };

  return (
    <div
      className={`canvas-node ${focused ? 'focused' : ''} ${selected ? 'selected' : ''}`}
      style={{
        left: node.origin.x,
        top: node.origin.y,
        width: node.size.width,
        height: node.size.height,
        zIndex: node.zOrder,
      }}
      onPointerDownCapture={() => store.getState().focusNode(nodeId)}
      data-node-id={nodeId}
    >
      <header
        className="canvas-node-titlebar"
        onPointerDown={onTitlePointerDown}
        onPointerMove={onTitlePointerMove}
        onPointerUp={onTitlePointerUp}
        onPointerCancel={onTitlePointerUp}
      >
        <span className="canvas-node-title">{getPanelTitle(node.panel)}</span>
        <button
          className="canvas-node-close"
          aria-label={`Remove ${getPanelTitle(node.panel)} from canvas`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => store.getState().removeNode(nodeId)}
        >
          <Icon name="close" size={13} />
        </button>
      </header>
      <div className="canvas-node-body">
        <PanelHost panel={node.panel} />
      </div>
      {RESIZE_EDGES.map((edge) => (
        <div
          key={edge}
          className={`canvas-node-resize canvas-node-resize-${edge}`}
          data-edge={edge}
          aria-hidden="true"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
        />
      ))}
    </div>
  );
}
