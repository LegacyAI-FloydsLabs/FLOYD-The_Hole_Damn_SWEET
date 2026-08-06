// CURSE'M IDE — dock tab drag/drop resolution.
//
// Drag a panel tab onto a zone (or a stack edge inside it) and this hook
// resolves the drop: center of a stack → tab (insert at hovered tab index),
// outer 22% band of a stack → split in that direction. Tracks a highlight
// rect the zone renders as the drop indicator.

import { useCallback, useRef, useState, type DragEvent as ReactDragEvent, type RefObject } from 'react';
import { PANEL_DRAG_MIME } from '@/panels/dragTypes';
import { findFirstTabsNode, useDockStore, type DockDropTarget, type DockEdge, type DockZoneId } from './dockStore';

export interface DockDropHighlight {
  left: number;
  top: number;
  width: number;
  height: number;
}

const EDGE_BAND = 0.22;

interface ResolvedDrop {
  target: DockDropTarget;
  highlight: DockDropHighlight;
}

function resolveDrop(event: ReactDragEvent, zoneElement: HTMLElement, zoneId: DockZoneId): ResolvedDrop | null {
  const zoneRect = zoneElement.getBoundingClientRect();

  const stackElement = (event.target as HTMLElement).closest?.('[data-stack-id]') as HTMLElement | null;
  if (!stackElement) {
    // Dropping on zone chrome (outside any stack): tab into the zone's
    // first stack, highlighted as the whole zone.
    const zone = useDockStore.getState().zones[zoneId];
    const firstStack = zone?.layout ? findFirstTabsNode(zone.layout) : null;
    if (!firstStack) return null;
    return {
      target: { type: 'tab', stackId: firstStack.id },
      highlight: { left: 0, top: 0, width: zoneRect.width, height: zoneRect.height },
    };
  }

  const stackId = stackElement.dataset.stackId;
  if (!stackId) return null;
  const rect = stackElement.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const fx = rect.width > 0 ? x / rect.width : 0.5;
  const fy = rect.height > 0 ? y / rect.height : 0.5;

  let edge: DockEdge | null = null;
  if (fx < EDGE_BAND) edge = 'left';
  else if (fx > 1 - EDGE_BAND) edge = 'right';
  else if (fy < EDGE_BAND) edge = 'top';
  else if (fy > 1 - EDGE_BAND) edge = 'bottom';

  if (edge) {
    const bandX = edge === 'left' ? rect.left : edge === 'right' ? rect.right - rect.width * EDGE_BAND : rect.left;
    const bandY = edge === 'top' ? rect.top : edge === 'bottom' ? rect.bottom - rect.height * EDGE_BAND : rect.top;
    const bandW = edge === 'left' || edge === 'right' ? rect.width * EDGE_BAND : rect.width;
    const bandH = edge === 'top' || edge === 'bottom' ? rect.height * EDGE_BAND : rect.height;
    return {
      target: { type: 'split', stackId, edge },
      highlight: { left: bandX - zoneRect.left, top: bandY - zoneRect.top, width: bandW, height: bandH },
    };
  }

  const tabElement = (event.target as HTMLElement).closest?.('[data-tab-index]') as HTMLElement | null;
  const index = tabElement?.dataset.tabIndex !== undefined ? Number(tabElement.dataset.tabIndex) : undefined;
  return {
    target: { type: 'tab', stackId, index },
    highlight: { left: rect.left - zoneRect.left, top: rect.top - zoneRect.top, width: rect.width, height: rect.height },
  };
}

export function useDockTabDrag(zoneId: DockZoneId, zoneRef: RefObject<HTMLElement | null>) {
  const [highlight, setHighlight] = useState<DockDropHighlight | null>(null);
  const resolvedRef = useRef<ResolvedDrop | null>(null);

  const onDragOver = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes(PANEL_DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const zoneElement = zoneRef.current;
    if (!zoneElement) return;
    const resolved = resolveDrop(event, zoneElement, zoneId);
    resolvedRef.current = resolved;
    setHighlight(resolved?.highlight ?? null);
  }, [zoneRef, zoneId]);

  const onDragLeave = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    resolvedRef.current = null;
    setHighlight(null);
  }, []);

  const onDrop = useCallback((event: ReactDragEvent<HTMLElement>) => {
    const panelId = event.dataTransfer.getData(PANEL_DRAG_MIME);
    const target = resolvedRef.current?.target;
    resolvedRef.current = null;
    setHighlight(null);
    if (!panelId) return;
    event.preventDefault();
    const dock = useDockStore.getState();
    const panel = dock.panels[panelId];
    if (!panel) return;
    dock.dockPanel(panel, zoneId, target);
  }, [zoneId]);

  return { highlight, onDragOver, onDragLeave, onDrop };
}
