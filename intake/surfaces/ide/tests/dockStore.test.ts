import { beforeEach, describe, expect, it } from 'vitest';
import {
  findFirstTabsNode,
  findTabsNode,
  getPanelLocation,
  insertIntoSplit,
  removePanelFromTree,
  resetDockStore,
  useDockStore,
  type DockLayoutNode,
} from '@/dock/dockStore';
import { panelIdForType, type PanelState } from '@/panels/types';

const panel = (type: PanelState['type']): PanelState => ({ id: panelIdForType(type), type, title: type });

const tabs = (id: string, panelIds: string[]): DockLayoutNode => ({ type: 'tabs', id, panelIds, activeIndex: 0 });

describe('dock tree ops', () => {
  it('removePanelFromTree collapses single-child splits and renormalizes ratios', () => {
    const tree: DockLayoutNode = {
      type: 'split', id: 's1', direction: 'horizontal',
      children: [tabs('a', ['p1']), tabs('b', ['p2'])],
      ratios: [0.25, 0.75],
    };
    const next = removePanelFromTree(tree, 'p2');
    expect(next).toMatchObject({ type: 'tabs', id: 'a', panelIds: ['p1'] });
  });

  it('removePanelFromTree renormalizes when a middle child empties', () => {
    const tree: DockLayoutNode = {
      type: 'split', id: 's1', direction: 'vertical',
      children: [tabs('a', ['p1']), tabs('b', ['p2']), tabs('c', ['p3'])],
      ratios: [0.2, 0.3, 0.5],
    };
    const next = removePanelFromTree(tree, 'p2');
    expect(next?.type).toBe('split');
    if (next?.type !== 'split') throw new Error('expected split');
    expect(next.children.map((child) => child.id)).toEqual(['a', 'c']);
    const sum = next.ratios.reduce((total, ratio) => total + ratio, 0);
    expect(sum).toBeCloseTo(1);
    expect(next.ratios[1]).toBeCloseTo(0.5 / 0.7);
  });

  it('insertIntoSplit halves the sibling ratio for the newcomer', () => {
    const tree = tabs('a', ['p1']);
    const next = insertIntoSplit(tree, 'a', 'p2', 'right');
    if (next.type !== 'split') throw new Error('expected split');
    expect(next.direction).toBe('horizontal');
    expect(next.ratios).toEqual([0.5, 0.5]);
  });

  it('same-direction splits stay flat as siblings', () => {
    const tree = insertIntoSplit(tabs('a', ['p1']), 'a', 'p2', 'right');
    const next = insertIntoSplit(tree, 'a', 'p3', 'right');
    if (next.type !== 'split') throw new Error('expected split');
    expect(next.children).toHaveLength(3);
    const sum = next.ratios.reduce((total, ratio) => total + ratio, 0);
    expect(sum).toBeCloseTo(1);
    // Stack 'a' was halved once for p2 (0.25 of total) and again for p3.
    expect(next.ratios[0]).toBeCloseTo(0.25);
  });

  it('opposite-direction splits nest a new split', () => {
    const tree = insertIntoSplit(tabs('a', ['p1']), 'a', 'p2', 'right');
    const next = insertIntoSplit(tree, 'a', 'p3', 'bottom');
    if (next.type !== 'split') throw new Error('expected split');
    expect(next.children).toHaveLength(2);
    const nested = next.children[0];
    if (nested.type !== 'split') throw new Error('expected nested split');
    expect(nested.direction).toBe('vertical');
  });
});

describe('dock store', () => {
  beforeEach(() => {
    localStorage.clear();
    resetDockStore();
  });

  it('derives panel location from the tree (no reverse index)', () => {
    const location = getPanelLocation(useDockStore.getState().zones, panelIdForType('terminal'));
    expect(location).toMatchObject({ zoneId: 'bottom' });
  });

  it('moving a panel to another zone leaves it in exactly one place', () => {
    const dock = useDockStore.getState();
    dock.dockPanel(panel('terminal'), 'left');
    const zones = useDockStore.getState().zones;
    expect(getPanelLocation(zones, panelIdForType('terminal'))).toMatchObject({ zoneId: 'left' });
    expect(findTabsNode(zones.bottom.layout, findFirstTabsNode(zones.bottom.layout)?.id ?? '')).toBeNull();
  });

  it('closing the last panel in a non-center zone auto-hides it', () => {
    const dock = useDockStore.getState();
    dock.undockPanel(panelIdForType('terminal'));
    const bottom = useDockStore.getState().zones.bottom;
    expect(bottom.layout).toBeNull();
    expect(bottom.visible).toBe(false);
    // Legacy uiStore flag follows so ⌘J and TerminalPane stay consistent.
    // (Written back by the store's visibility sync.)
  });

  it('re-docking an emptied zone shows it again', () => {
    const dock = useDockStore.getState();
    dock.undockPanel(panelIdForType('terminal'));
    dock.dockPanel(panel('terminal'), 'bottom');
    expect(useDockStore.getState().zones.bottom.visible).toBe(true);
  });

  it('snapshot/restore round-trips the zone trees', () => {
    const dock = useDockStore.getState();
    dock.dockPanel(panel('git'), 'left', {
      type: 'split',
      stackId: findFirstTabsNode(useDockStore.getState().zones.left.layout)!.id,
      edge: 'bottom',
    });
    const snapshot = dock.getSnapshot();
    dock.undockPanel(panelIdForType('git'));
    expect(getPanelLocation(useDockStore.getState().zones, panelIdForType('git'))).toBeNull();
    dock.restoreSnapshot(snapshot);
    const zones = useDockStore.getState().zones;
    expect(getPanelLocation(zones, panelIdForType('git'))).toMatchObject({ zoneId: 'left' });
    expect(zones.left.layout?.type).toBe('split');
  });
});
