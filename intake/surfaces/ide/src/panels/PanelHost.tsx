// CURSE'M IDE — panel host.
//
// Renders a panel by id inside either a dock tab or a canvas node. The host
// is deliberately thin: all lookup goes through the panel registry and all
// layout state lives in the dock/canvas stores.

import { Suspense } from 'react';
import { getPanelDefinition } from './registry';
import type { PanelState } from './types';

export function PanelHost({ panel }: { panel: PanelState }) {
  const definition = getPanelDefinition(panel.type);
  const Component = definition.component;
  return (
    <div className="panel-host" data-panel-type={panel.type}>
      <Suspense fallback={<p className="panel-caption">{definition.loadingCaption}</p>}>
        <Component panel={panel} />
      </Suspense>
    </div>
  );
}
