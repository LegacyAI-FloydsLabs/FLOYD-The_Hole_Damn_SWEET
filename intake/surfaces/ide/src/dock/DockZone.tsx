// CURSE'M IDE — dock zone.
//
// One of the four shell zones (left/right/bottom/center). Renders its
// layout tree plus: the zone-edge resize handle (feeding the clamped legacy
// uiStore setters, which stay the persisted size authority) and the drop
// highlight for tab drags. Hidden or empty non-center zones render nothing.

import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useUIStore } from '@/store/uiStore';
import { useDockStore, type DockZoneId } from './dockStore';
import { DockLayoutRenderer } from './DockLayoutRenderer';
import { useDockTabDrag } from './useDockTabDrag';

const ZONE_RESIZE: Record<'left' | 'right' | 'bottom', {
  axis: 'x' | 'y';
  direction: 1 | -1;
  read: () => number;
  write: (value: number) => void;
}> = {
  left: {
    axis: 'x', direction: 1,
    read: () => useUIStore.getState().sidePanelWidth,
    write: (value) => useUIStore.getState().setSidePanelWidth(value),
  },
  right: {
    axis: 'x', direction: -1,
    read: () => useUIStore.getState().aiPanelWidth,
    write: (value) => useUIStore.getState().setAIPanelWidth(value),
  },
  bottom: {
    axis: 'y', direction: -1,
    read: () => useUIStore.getState().terminalHeight,
    write: (value) => useUIStore.getState().setTerminalHeight(value),
  },
};

function ZoneResizeHandle({ zoneId }: { zoneId: 'left' | 'right' | 'bottom' }) {
  const config = ZONE_RESIZE[zoneId];
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const start = config.axis === 'x' ? event.clientX : event.clientY;
    const startSize = config.read();
    const move = (moveEvent: PointerEvent) => {
      const position = config.axis === 'x' ? moveEvent.clientX : moveEvent.clientY;
      config.write(startSize + (position - start) * config.direction);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };
  return (
    <div
      className={`resize-handle ${config.axis === 'x' ? 'vertical' : 'horizontal'} dock-zone-handle dock-zone-handle-${zoneId}`}
      aria-hidden="true"
      onPointerDown={onPointerDown}
    />
  );
}

export function DockZone({ zoneId }: { zoneId: DockZoneId }) {
  const zone = useDockStore((state) => state.zones[zoneId]);
  const zoneRef = useRef<HTMLElement | null>(null);
  const { highlight, onDragOver, onDragLeave, onDrop } = useDockTabDrag(zoneId, zoneRef);

  if (!zone.visible || !zone.layout) return null;

  const style: CSSProperties = {};
  if (zoneId === 'left' || zoneId === 'right') style.width = zone.size;
  if (zoneId === 'bottom') style.height = zone.size;

  return (
    <section
      ref={zoneRef}
      className={`dock-zone dock-zone-${zoneId}`}
      style={style}
      aria-label={`${zoneId} dock zone`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {zoneId === 'right' && <ZoneResizeHandle zoneId="right" />}
      {zoneId === 'bottom' && <ZoneResizeHandle zoneId="bottom" />}
      <DockLayoutRenderer zoneId={zoneId} node={zone.layout} />
      {zoneId === 'left' && <ZoneResizeHandle zoneId="left" />}
      {highlight && (
        <div
          className="dock-drop-highlight"
          style={{ left: highlight.left, top: highlight.top, width: highlight.width, height: highlight.height }}
          aria-hidden="true"
        />
      )}
    </section>
  );
}
