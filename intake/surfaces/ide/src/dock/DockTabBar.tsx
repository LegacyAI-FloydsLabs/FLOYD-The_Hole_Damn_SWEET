// CURSE'M IDE — dock tab bar.
//
// Tabs for one stack. Click activates, middle/close-button undocks the
// panel (closing the last panel in a non-center zone auto-hides it), and
// tabs are drag sources for zone/split moves (payload: PANEL_DRAG_MIME).

import { Icon } from '@/components/Icon';
import { PANEL_DRAG_MIME } from '@/panels/dragTypes';
import { getPanelTitle } from '@/panels/registry';
import { useDockStore, type DockTabsNode, type DockZoneId } from './dockStore';

export function DockTabBar({ zoneId, stack }: { zoneId: DockZoneId; stack: DockTabsNode }) {
  const panels = useDockStore((state) => state.panels);
  const setActiveTabIndex = useDockStore((state) => state.setActiveTabIndex);
  const undockPanel = useDockStore((state) => state.undockPanel);

  return (
    <div className="dock-tab-bar" role="tablist" aria-label="Docked panels">
      {stack.panelIds.map((panelId, index) => {
        const panel = panels[panelId];
        if (!panel) return null;
        const title = getPanelTitle(panel);
        const active = index === stack.activeIndex;
        return (
          <div
            key={panelId}
            className={`dock-tab ${active ? 'active' : ''}`}
            role="tab"
            aria-selected={active}
            data-tab-index={index}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(PANEL_DRAG_MIME, panelId);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onClick={() => setActiveTabIndex(zoneId, stack.id, index)}
            onAuxClick={(event) => event.button === 1 && undockPanel(panelId)}
            title={title}
          >
            <span className="dock-tab-name">{title}</span>
            <button
              className="dock-tab-close"
              aria-label={`Close ${title}`}
              onClick={(event) => { event.stopPropagation(); undockPanel(panelId); }}
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
