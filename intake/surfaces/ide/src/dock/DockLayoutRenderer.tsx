// CURSE'M IDE — dock layout renderer.
//
// Recursively renders a zone's tabs/split tree. A tabs node = DockTabBar +
// the active panel (PanelHost); a split node = flex row/column of children
// with DockResizeHandle dividers. Inactive tabs unmount (same lifecycle the
// old fixed shell had for hidden panels).

import { Fragment } from 'react';
import { PanelHost } from '@/panels/PanelHost';
import { useDockStore, type DockLayoutNode, type DockZoneId } from './dockStore';
import { DockTabBar } from './DockTabBar';
import { adjustRatioPair, DockResizeHandle } from './DockResizeHandle';

export function DockLayoutRenderer({ zoneId, node }: { zoneId: DockZoneId; node: DockLayoutNode }) {
  const panels = useDockStore((state) => state.panels);
  const setSplitRatios = useDockStore((state) => state.setSplitRatios);

  if (node.type === 'tabs') {
    const activePanel = panels[node.panelIds[node.activeIndex]];
    return (
      <div className="dock-stack" data-stack-id={node.id}>
        <DockTabBar zoneId={zoneId} stack={node} />
        <div className="dock-stack-body">
          {activePanel && <PanelHost panel={activePanel} />}
        </div>
      </div>
    );
  }

  return (
    <div className={`dock-split dock-split-${node.direction}`} data-split-id={node.id}>
      {node.children.map((child, index) => (
        <Fragment key={child.id}>
          {index > 0 && (
            <DockResizeHandle
              direction={node.direction}
              onDragRatio={(delta) => setSplitRatios(zoneId, node.id, adjustRatioPair(node.ratios, index - 1, delta))}
            />
          )}
          <div className="dock-split-child" style={{ flexGrow: node.ratios[index] ?? 1, flexBasis: 0 }}>
            <DockLayoutRenderer zoneId={zoneId} node={child} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}
