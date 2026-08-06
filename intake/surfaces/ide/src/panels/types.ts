// CURSE'M IDE — panel model.
//
// A "panel" is any rectangular content unit the workbench can host — in a
// dock zone (tabs/splits, src/dock/) or as a node on the infinite canvas
// (src/canvas/). This module is the single panel-type enumeration for the
// whole surface: other feature clusters (agent panels, diff viewers,
// browser panels) register their types here via PANEL_DEFINITIONS in
// registry.tsx instead of inventing parallel registries.
//
// Panels are singletons by type in this build: every workbench feature
// (explorer, terminal, editor stack, AI chat…) is one live component tree,
// so a panel has exactly one location at a time — a dock-zone tab or a
// canvas node. Panel location is *derived* from the dock tree and canvas
// nodes on demand (see src/panels/panelOps.ts); nothing stores a reverse
// index that could desync.

/** Every panel type the shell can host. 'canvas' is the primary spatial
 *  workspace itself (nested canvases are deferred to a later phase). */
export type PanelType =
  | 'explorer'
  | 'search'
  | 'git'
  | 'debug'
  | 'extensions'
  | 'skills'
  | 'editor'
  | 'terminal'
  | 'ai-chat'
  | 'canvas';

export interface PanelState {
  /** Stable id — `panel:<type>` for the singleton panels. */
  id: string;
  type: PanelType;
  title: string;
  /** Editor panels only: the file this panel is bound to. Unused in the
   *  current singleton editor stack, reserved for per-file editor panels. */
  filePath?: string;
}

/** Stable id for a singleton panel of the given type. */
export function panelIdForType(type: PanelType): string {
  return `panel:${type}`;
}
