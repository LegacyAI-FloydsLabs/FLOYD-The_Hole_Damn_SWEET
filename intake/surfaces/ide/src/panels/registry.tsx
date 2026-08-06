// CURSE'M IDE — panel registry.
//
// Maps every PanelType to its title and lazily-loaded component, reusing the
// lazy() pattern established in AppShell. This is the single panel-type
// enumeration other feature clusters register into (agent panels, diff
// viewers, browser panels): add a PanelType in types.ts plus an entry here —
// nothing else in the dock/canvas substrate hardcodes panel types.

import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { FileTree, SearchPanel } from '@/workspace';
import type { PanelState, PanelType } from './types';
import { EditorStackPanel } from './EditorStackPanel';

const TerminalPane = lazy(() => import('@/terminal/TerminalPane').then((module) => ({ default: module.TerminalPane })));
const AIChatPane = lazy(() => import('@/opencode/AIChatPane').then((module) => ({ default: module.AIChatPane })));
const GitPanel = lazy(() => import('@/git/GitPanel').then((module) => ({ default: module.GitPanel })));
const DebugPanel = lazy(() => import('@/debug/DebugPanel').then((module) => ({ default: module.DebugPanel })));
const ExtensionsPanel = lazy(() => import('@/components/ExtensionsPanel').then((module) => ({ default: module.ExtensionsPanel })));
const SkillsPanel = lazy(() => import('@/components/SkillsPanel').then((module) => ({ default: module.SkillsPanel })));
// The canvas module is chunk-split so the workbench entry stays within its
// bundle budget; it mounts when the center zone first renders.
const CanvasView = lazy(() => import('@/canvas/CanvasView').then((module) => ({ default: module.CanvasView })));

export type PanelComponentProps = { panel: PanelState };
export type PanelComponent = ComponentType<PanelComponentProps> | LazyExoticComponent<ComponentType<PanelComponentProps>>;

export interface PanelDefinition {
  title: string;
  /** Fallback caption shown while the lazy component loads. */
  loadingCaption: string;
  component: PanelComponent;
}

// Components that ignore props satisfy PanelComponentProps structurally.
const asPanelComponent = (component: unknown): PanelComponent =>
  component as PanelComponent;

export const PANEL_DEFINITIONS: Record<PanelType, PanelDefinition> = {
  explorer: { title: 'Explorer', loadingCaption: 'Loading workbench view…', component: asPanelComponent(FileTree) },
  search: { title: 'Search', loadingCaption: 'Loading workbench view…', component: asPanelComponent(SearchPanel) },
  git: { title: 'Source Control', loadingCaption: 'Loading workbench view…', component: asPanelComponent(GitPanel) },
  debug: { title: 'Run and Debug', loadingCaption: 'Loading workbench view…', component: asPanelComponent(DebugPanel) },
  extensions: { title: 'Integrations', loadingCaption: 'Loading workbench view…', component: asPanelComponent(ExtensionsPanel) },
  skills: { title: 'Skills', loadingCaption: 'Loading skills…', component: asPanelComponent(SkillsPanel) },
  editor: { title: 'Editor', loadingCaption: 'Loading editor…', component: asPanelComponent(EditorStackPanel) },
  terminal: { title: 'Terminal', loadingCaption: 'Loading terminal…', component: asPanelComponent(TerminalPane) },
  'ai-chat': { title: 'Coding Partner', loadingCaption: 'Loading coding partner…', component: asPanelComponent(AIChatPane) },
  canvas: { title: 'Canvas', loadingCaption: 'Loading canvas…', component: asPanelComponent(CanvasView) },
};

export function getPanelDefinition(type: PanelType): PanelDefinition {
  return PANEL_DEFINITIONS[type];
}

/** Derive the live title for a panel (file-bound panels name their file). */
export function getPanelTitle(panel: PanelState): string {
  if (panel.filePath) return panel.filePath.split('/').pop() || panel.title;
  return PANEL_DEFINITIONS[panel.type]?.title ?? panel.title;
}
