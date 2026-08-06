// CURSE'M IDE — canvas grid.
//
// Screen-space grid rendered OUTSIDE the world transform so lines land on
// whole device pixels at any zoom. CanvasView repositions/rescales the
// background imperatively in the same store-notification tick as the world
// transform (no React re-render per frame).

import { forwardRef } from 'react';

export const CanvasGrid = forwardRef<HTMLDivElement>(function CanvasGrid(_props, ref) {
  return <div ref={ref} className="canvas-grid" aria-hidden="true" />;
});
