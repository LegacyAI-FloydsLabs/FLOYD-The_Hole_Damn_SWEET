// CURSE'M IDE — dock resize handle.
//
// Divider between two split children. Dragging adjusts the ratio of the two
// neighbors only (flat same-direction splits keep every handle local). The
// delta is computed against the split container's size at drag start.

import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { DockDirection } from './dockStore';

const MIN_RATIO = 0.08;

export function DockResizeHandle({
  direction,
  onDragRatio,
}: {
  direction: DockDirection;
  /** Called with the signed ratio delta to move from the trailing child to
   *  the leading child (positive grows the child before the handle). */
  onDragRatio: (deltaRatio: number) => void;
}) {
  const dragRef = useRef<{ pointerId: number; start: number; containerSize: number } | null>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const container = event.currentTarget.parentElement;
    const containerSize = container
      ? (direction === 'horizontal' ? container.clientWidth : container.clientHeight)
      : 0;
    if (containerSize <= 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      start: direction === 'horizontal' ? event.clientX : event.clientY,
      containerSize,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const position = direction === 'horizontal' ? event.clientX : event.clientY;
    onDragRatio((position - drag.start) / drag.containerSize);
    drag.start = position;
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
  };

  return (
    <div
      className={`resize-handle ${direction === 'horizontal' ? 'vertical' : 'horizontal'}`}
      aria-hidden="true"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}

/** Ratio pair adjustment used by split containers: keep the pair's sum,
 *  clamp both ends so neither child collapses to zero. */
export function adjustRatioPair(ratios: number[], index: number, delta: number): number[] {
  const next = [...ratios];
  const a = next[index] ?? 0;
  const b = next[index + 1] ?? 0;
  const sum = a + b;
  if (sum <= 0) return next;
  const clamped = Math.min(sum - MIN_RATIO * sum, Math.max(MIN_RATIO * sum, a + delta));
  next[index] = clamped;
  next[index + 1] = sum - clamped;
  return next;
}
