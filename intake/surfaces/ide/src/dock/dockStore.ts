// CURSE'M IDE — dock store.
//
// VS Code-style docking coexisting with the free canvas (feature-map
// §Workflow 2). Four zones — left/right/bottom/center — each holding a
// normalized tree of tabs/split nodes:
//
//   DockLayoutNode = { type:'tabs',  id, panelIds, activeIndex }
//                  | { type:'split', id, direction, children, ratios }
//
// Invariants (enforced by the pure tree ops below):
//   - removing a panel collapses single-child splits and renormalizes ratios;
//   - splitting a stack halves the sibling's ratio for the newcomer;
//   - same-direction splits stay FLAT (new stack inserts as a sibling, so
//     every resize handle only ever affects its two neighbors);
//   - an emptied non-center zone auto-hides;
//   - panel location is DERIVED from the tree on demand (getPanelLocation) —
//     no stored reverse index to desync.
//
// Zone size and the three legacy visibility flags (activePanel,
// terminalVisible, aiChatVisible) stay owned by uiStore; this store mirrors
// them via subscription and writes back when dock interactions
// (close-last-tab auto-hide, drag-in) change effective visibility.

import { create } from 'zustand';
import { panelIdForType, type PanelState, type PanelType } from '@/panels/types';
import { useUIStore, type SidePanel } from '@/store/uiStore';

export const DEFAULT_SIDE_ZONE_SIZE = 260;
export const DEFAULT_BOTTOM_ZONE_SIZE = 240;
export const MIN_ZONE_SIZE = 120;

export type DockZoneId = 'left' | 'right' | 'bottom' | 'center';
export type DockDirection = 'horizontal' | 'vertical';
export type DockEdge = 'left' | 'right' | 'top' | 'bottom';

export interface DockTabsNode {
  type: 'tabs';
  id: string;
  panelIds: string[];
  activeIndex: number;
}

export interface DockSplitNode {
  type: 'split';
  id: string;
  direction: DockDirection;
  children: DockLayoutNode[];
  ratios: number[];
}

export type DockLayoutNode = DockTabsNode | DockSplitNode;

export interface DockZoneState {
  visible: boolean;
  /** Width (left/right) or height (bottom) in px; center ignores it. */
  size: number;
  layout: DockLayoutNode | null;
}

export type DockDropTarget =
  | { type: 'tab'; stackId: string; index?: number }
  | { type: 'split'; stackId: string; edge: DockEdge };

export interface DockSnapshot {
  zones: Record<DockZoneId, DockZoneState>;
}

interface DockStoreState {
  zones: Record<DockZoneId, DockZoneState>;
  /** Runtime panel registry — every panel the shell knows about, whether
   *  docked, on a canvas, or currently unplaced. */
  panels: Record<string, PanelState>;

  registerPanel: (panel: PanelState) => void;
  dockPanel: (panel: PanelState, zoneId: DockZoneId, target?: DockDropTarget) => void;
  undockPanel: (panelId: string) => void;
  activatePanel: (panelId: string) => void;
  setActiveTabIndex: (zoneId: DockZoneId, stackId: string, index: number) => void;
  setSplitRatios: (zoneId: DockZoneId, splitId: string, ratios: number[]) => void;
  setZoneSize: (zoneId: DockZoneId, size: number) => void;
  setZoneVisible: (zoneId: DockZoneId, visible: boolean) => void;
  getSnapshot: () => DockSnapshot;
  restoreSnapshot: (snapshot: DockSnapshot) => void;
}

let dockSeq = 0;
const nextDockId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++dockSeq}`;

// Panels are singletons with exactly one location across BOTH substrates
// (dock tree or canvas node). dockStore must not import the canvas layer, so
// panelOps registers this interceptor: before a panel is docked it is pulled
// out of any canvas node, keeping the one-location invariant intact.
let panelMoveInterceptor: ((panelId: string) => void) | null = null;

export function setPanelMoveInterceptor(interceptor: (panelId: string) => void): void {
  panelMoveInterceptor = interceptor;
}

function makeTabsNode(panelIds: string[], activeIndex = 0): DockTabsNode {
  return { type: 'tabs', id: nextDockId('tabs'), panelIds: [...panelIds], activeIndex };
}

function normalizeRatios(ratios: number[]): number[] {
  const sum = ratios.reduce((total, ratio) => total + ratio, 0);
  if (sum <= 0) return ratios.map(() => 1 / Math.max(1, ratios.length));
  return ratios.map((ratio) => ratio / sum);
}

export function findTabsNode(tree: DockLayoutNode | null, stackId: string): DockTabsNode | null {
  if (!tree) return null;
  if (tree.type === 'tabs') return tree.id === stackId ? tree : null;
  for (const child of tree.children) {
    const found = findTabsNode(child, stackId);
    if (found) return found;
  }
  return null;
}

export function findFirstTabsNode(tree: DockLayoutNode | null): DockTabsNode | null {
  if (!tree) return null;
  if (tree.type === 'tabs') return tree;
  for (const child of tree.children) {
    const found = findFirstTabsNode(child);
    if (found) return found;
  }
  return null;
}

function findParentSplit(tree: DockLayoutNode, childId: string): DockSplitNode | null {
  if (tree.type === 'tabs') return null;
  for (const child of tree.children) {
    if (child.id === childId) return tree;
    const found = findParentSplit(child, childId);
    if (found) return found;
  }
  return null;
}

/**
 * Remove a panel from a tree. Collapses single-child splits and
 * renormalizes ratios. Returns the new tree, or null when the tree emptied.
 */
export function removePanelFromTree(tree: DockLayoutNode, panelId: string): DockLayoutNode | null {
  const copy = structuredClone(tree);

  const prune = (node: DockLayoutNode): DockLayoutNode | null => {
    if (node.type === 'tabs') {
      const index = node.panelIds.indexOf(panelId);
      if (index >= 0) {
        node.panelIds.splice(index, 1);
        node.activeIndex = Math.min(node.activeIndex, Math.max(0, node.panelIds.length - 1));
      }
      return node.panelIds.length > 0 ? node : null;
    }
    const surviving: Array<{ child: DockLayoutNode; ratio: number }> = [];
    node.children.forEach((child, index) => {
      const pruned = prune(child);
      if (pruned) surviving.push({ child: pruned, ratio: node.ratios[index] ?? 1 });
    });
    if (surviving.length === 0) return null;
    if (surviving.length === 1) return surviving[0].child; // collapse
    node.children = surviving.map((entry) => entry.child);
    node.ratios = normalizeRatios(surviving.map((entry) => entry.ratio));
    return node;
  };

  return prune(copy);
}

/**
 * Insert a panel as a new tab stack split off the edge of an existing stack.
 * If the parent split already runs in that direction the new stack becomes a
 * flat sibling (ratio carved from the neighbor); otherwise a new two-child
 * split replaces the stack. Returns the new tree.
 */
export function insertIntoSplit(tree: DockLayoutNode, stackId: string, panelId: string, edge: DockEdge): DockLayoutNode {
  const copy = structuredClone(tree);
  const stack = findTabsNode(copy, stackId);
  if (!stack) return copy;
  const direction: DockDirection = edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical';
  const before = edge === 'left' || edge === 'top';
  const newStack = makeTabsNode([panelId]);

  const parent = findParentSplit(copy, stackId);
  if (parent && parent.direction === direction) {
    // Stay flat: insert as a sibling, halving the neighbor's ratio.
    const index = parent.children.findIndex((child) => child.id === stackId);
    const neighborRatio = parent.ratios[index] ?? 1 / parent.children.length;
    parent.ratios[index] = neighborRatio / 2;
    parent.children.splice(before ? index : index + 1, 0, newStack);
    parent.ratios.splice(before ? index : index + 1, 0, neighborRatio / 2);
    parent.ratios = normalizeRatios(parent.ratios);
    return copy;
  }

  const split: DockSplitNode = {
    type: 'split',
    id: nextDockId('split'),
    direction,
    children: before ? [newStack, stack] : [stack, newStack],
    ratios: [0.5, 0.5],
  };
  if (!parent) return split;
  const index = parent.children.findIndex((child) => child.id === stackId);
  parent.children[index] = split;
  return copy;
}

/** Insert a panel as a tab in an existing stack. Returns the new tree. */
export function insertTabIntoTree(tree: DockLayoutNode, stackId: string, panelId: string, index?: number): DockLayoutNode {
  const copy = structuredClone(tree);
  const stack = findTabsNode(copy, stackId);
  if (!stack) return copy;
  const at = index === undefined ? stack.panelIds.length : Math.max(0, Math.min(stack.panelIds.length, index));
  stack.panelIds.splice(at, 0, panelId);
  stack.activeIndex = at;
  return copy;
}

function* walkTabs(tree: DockLayoutNode | null): Generator<DockTabsNode> {
  if (!tree) return;
  if (tree.type === 'tabs') {
    yield tree;
    return;
  }
  for (const child of tree.children) yield* walkTabs(child);
}

export interface PanelLocation {
  zoneId: DockZoneId;
  stackId: string;
}

/** Derive a panel's dock location from the zone trees — the only location
 *  lookup; nothing stores a reverse index. */
export function getPanelLocation(zones: Record<DockZoneId, DockZoneState>, panelId: string): PanelLocation | null {
  for (const zoneId of Object.keys(zones) as DockZoneId[]) {
    for (const stack of walkTabs(zones[zoneId].layout)) {
      if (stack.panelIds.includes(panelId)) return { zoneId, stackId: stack.id };
    }
  }
  return null;
}

const SIDE_PANEL_TYPES: readonly PanelType[] = ['explorer', 'search', 'git', 'debug', 'extensions', 'skills'];

function makePanel(type: PanelType): PanelState {
  return { id: panelIdForType(type), type, title: type };
}

/** Write effective zone visibility back into the legacy uiStore flags so
 *  TerminalPane/DebugPanel/palette toggles stay consistent with the dock. */
function syncUiVisibility(zoneId: DockZoneId, visible: boolean): void {
  const ui = useUIStore.getState();
  if (zoneId === 'bottom' && ui.terminalVisible !== visible) useUIStore.setState({ terminalVisible: visible });
  if (zoneId === 'right' && ui.aiChatVisible !== visible) useUIStore.setState({ aiChatVisible: visible });
  if (zoneId === 'left' && !visible && ui.activePanel !== null) useUIStore.setState({ activePanel: null });
}

function syncUiPanelActive(panel: PanelState, zoneId: DockZoneId): void {
  const ui = useUIStore.getState();
  if (zoneId === 'left' && SIDE_PANEL_TYPES.includes(panel.type) && ui.activePanel !== panel.type) {
    useUIStore.setState({ activePanel: panel.type as SidePanel });
  }
  if (zoneId === 'bottom' && panel.type === 'terminal' && !ui.terminalVisible) useUIStore.setState({ terminalVisible: true });
  if (zoneId === 'right' && panel.type === 'ai-chat' && !ui.aiChatVisible) useUIStore.setState({ aiChatVisible: true });
}

function seedZones(): Record<DockZoneId, DockZoneState> {
  const ui = useUIStore.getState();
  const activeSide = ui.activePanel ?? 'explorer';
  return {
    left: {
      visible: ui.activePanel !== null,
      size: ui.sidePanelWidth,
      layout: makeTabsNode([panelIdForType(activeSide)]),
    },
    bottom: {
      visible: ui.terminalVisible,
      size: ui.terminalHeight,
      layout: makeTabsNode([panelIdForType('terminal')]),
    },
    right: {
      visible: ui.aiChatVisible,
      size: ui.aiPanelWidth,
      layout: makeTabsNode([panelIdForType('ai-chat')]),
    },
    center: {
      visible: true,
      size: 0,
      layout: makeTabsNode([panelIdForType('canvas')]),
    },
  };
}

function seedPanels(): Record<string, PanelState> {
  const panels: Record<string, PanelState> = {};
  for (const type of [...SIDE_PANEL_TYPES, 'editor', 'terminal', 'ai-chat', 'canvas'] as PanelType[]) {
    const panel = makePanel(type);
    panels[panel.id] = panel;
  }
  return panels;
}

export const useDockStore = create<DockStoreState>()((set, get) => ({
  zones: seedZones(),
  panels: seedPanels(),

  registerPanel: (panel) => set((state) => ({ panels: { ...state.panels, [panel.id]: panel } })),

  dockPanel: (panel, zoneId, target) => {
    get().registerPanel(panel);
    panelMoveInterceptor?.(panel.id);
    set((state) => {
      // Move semantics: a panel lives in exactly one place — pull it out of
      // any zone tree before docking it elsewhere.
      const zones = { ...state.zones };
      for (const id of Object.keys(zones) as DockZoneId[]) {
        const layout = zones[id].layout;
        if (layout && getPanelLocation({ [id]: zones[id] } as Record<DockZoneId, DockZoneState>, panel.id)) {
          zones[id] = { ...zones[id], layout: removePanelFromTree(layout, panel.id) };
        }
      }
      const zone = { ...zones[zoneId] };
      let layout = zone.layout;
      if (!layout) {
        layout = makeTabsNode([panel.id]);
      } else if (target?.type === 'split') {
        layout = insertIntoSplit(layout, target.stackId, panel.id, target.edge);
      } else {
        const stackId = target?.type === 'tab' ? target.stackId : findFirstTabsNode(layout)?.id;
        layout = stackId && findTabsNode(layout, stackId)
          ? insertTabIntoTree(layout, stackId, panel.id, target?.type === 'tab' ? target.index : undefined)
          : makeTabsNode([panel.id]);
      }
      zone.layout = layout;
      zone.visible = true;
      zones[zoneId] = zone;
      return { zones };
    });
    syncUiPanelActive(panel, zoneId);
  },

  undockPanel: (panelId) => {
    let emptiedZone: DockZoneId | null = null;
    set((state) => {
      const location = getPanelLocation(state.zones, panelId);
      if (!location) return state;
      const zone = { ...state.zones[location.zoneId] };
      zone.layout = zone.layout ? removePanelFromTree(zone.layout, panelId) : null;
      if (!zone.layout && location.zoneId !== 'center') {
        zone.visible = false;
        emptiedZone = location.zoneId;
      }
      return { zones: { ...state.zones, [location.zoneId]: zone } };
    });
    if (emptiedZone) syncUiVisibility(emptiedZone, false);
  },

  activatePanel: (panelId) => {
    set((state) => {
      const location = getPanelLocation(state.zones, panelId);
      if (!location) return state;
      const zone = { ...state.zones[location.zoneId], visible: true };
      const layout = structuredClone(zone.layout);
      const stack = findTabsNode(layout, location.stackId);
      if (stack) stack.activeIndex = Math.max(0, stack.panelIds.indexOf(panelId));
      zone.layout = layout;
      return { zones: { ...state.zones, [location.zoneId]: zone } };
    });
    const location = getPanelLocation(get().zones, panelId);
    const panel = get().panels[panelId];
    if (location && panel) syncUiPanelActive(panel, location.zoneId);
  },

  setActiveTabIndex: (zoneId, stackId, index) => set((state) => {
    const zone = { ...state.zones[zoneId] };
    const layout = structuredClone(zone.layout);
    const stack = findTabsNode(layout, stackId);
    if (!stack) return state;
    stack.activeIndex = Math.max(0, Math.min(stack.panelIds.length - 1, index));
    zone.layout = layout;
    const panelId = stack.panelIds[stack.activeIndex];
    const panel = panelId ? state.panels[panelId] : undefined;
    if (panel) queueMicrotask(() => syncUiPanelActive(panel, zoneId));
    return { zones: { ...state.zones, [zoneId]: zone } };
  }),

  setSplitRatios: (zoneId, splitId, ratios) => set((state) => {
    const zone = { ...state.zones[zoneId] };
    const layout = structuredClone(zone.layout);
    const applyTo = (node: DockLayoutNode | null): boolean => {
      if (!node || node.type === 'tabs') return false;
      if (node.id === splitId) {
        if (ratios.length === node.children.length) node.ratios = normalizeRatios(ratios);
        return true;
      }
      return node.children.some(applyTo);
    };
    if (!applyTo(layout)) return state;
    zone.layout = layout;
    return { zones: { ...state.zones, [zoneId]: zone } };
  }),

  setZoneSize: (zoneId, size) => set((state) => ({
    zones: { ...state.zones, [zoneId]: { ...state.zones[zoneId], size: Math.max(MIN_ZONE_SIZE, size) } },
  })),

  setZoneVisible: (zoneId, visible) => {
    set((state) => ({ zones: { ...state.zones, [zoneId]: { ...state.zones[zoneId], visible } } }));
    syncUiVisibility(zoneId, visible);
  },

  getSnapshot: () => structuredClone({ zones: get().zones }),

  restoreSnapshot: (snapshot) => set(() => ({ zones: structuredClone(snapshot.zones) })),
}));

// Mirror uiStore's legacy size/visibility flags into the zones. uiStore
// remains the persisted authority; this subscription is the only sync path.
useUIStore.subscribe((ui, prev) => {
  const dock = useDockStore.getState();

  if (ui.sidePanelWidth !== prev.sidePanelWidth) dock.setZoneSize('left', ui.sidePanelWidth);
  if (ui.terminalHeight !== prev.terminalHeight) dock.setZoneSize('bottom', ui.terminalHeight);
  if (ui.aiPanelWidth !== prev.aiPanelWidth) dock.setZoneSize('right', ui.aiPanelWidth);

  if (ui.activePanel !== prev.activePanel) {
    if (ui.activePanel === null) {
      if (dock.zones.left.visible) dock.setZoneVisible('left', false);
    } else {
      const panel = dock.panels[panelIdForType(ui.activePanel)] ?? makePanel(ui.activePanel);
      const location = getPanelLocation(dock.zones, panel.id);
      if (location) dock.activatePanel(panel.id);
      else dock.dockPanel(panel, 'left');
    }
  }

  if (ui.terminalVisible !== prev.terminalVisible) {
    const panel = dock.panels[panelIdForType('terminal')] ?? makePanel('terminal');
    if (ui.terminalVisible) {
      const location = getPanelLocation(dock.zones, panel.id);
      if (location) dock.activatePanel(panel.id);
      else dock.dockPanel(panel, 'bottom');
    } else if (dock.zones.bottom.visible && getPanelLocation(dock.zones, panel.id)?.zoneId === 'bottom') {
      dock.setZoneVisible('bottom', false);
    }
  }

  if (ui.aiChatVisible !== prev.aiChatVisible) {
    const panel = dock.panels[panelIdForType('ai-chat')] ?? makePanel('ai-chat');
    if (ui.aiChatVisible) {
      const location = getPanelLocation(dock.zones, panel.id);
      if (location) dock.activatePanel(panel.id);
      else dock.dockPanel(panel, 'right');
    } else if (dock.zones.right.visible && getPanelLocation(dock.zones, panel.id)?.zoneId === 'right') {
      dock.setZoneVisible('right', false);
    }
  }
});

/** Test support: restore the factory-seeded layout. */
export function resetDockStore(): void {
  useDockStore.setState({ zones: seedZones(), panels: seedPanels() });
}
