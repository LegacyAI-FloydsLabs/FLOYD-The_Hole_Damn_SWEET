// =============================================================================
// Unified theme schema (ported from Cate 1.5.3, MIT).
//
// A single JSON document is the import/export format for user themes. One
// document colors all three planes at once: app chrome (CURSEM semantic
// tokens → CSS custom properties), the terminal (full 16-color ANSI palette),
// and Monaco (base + token rules). The `app` map is partial-over-base: values
// are merged over BASE_DARK / BASE_LIGHT (presets.ts) chosen by `type`.
//
// CURSEM keeps its own semantic token names as the canonical chrome key set
// (the stylesheet already consumes them); the Cate → CURSEM key mapping is
// applied at conversion time (see cateThemes.ts for the built-in ports).
// =============================================================================

import { BASE_DARK, BASE_LIGHT } from './presets';
import { rgba } from './makeTheme';
import type { EditorTokenRule, ResolvedTheme, TerminalPalette, ThemeDefinition } from './types';

/** Bump when the UnifiedTheme shape changes incompatibly. Imports must match exactly. */
export const THEME_SCHEMA_VERSION = 1;

/** The chrome token keys an imported theme may override. This is the
 *  canonical list the validator filters `app` maps against. */
export const APP_COLOR_KEYS = [
  'bg.canvas', 'bg.editor', 'bg.surface', 'bg.raised', 'bg.hover', 'bg.active',
  'border.primary', 'border.strong', 'border.focus',
  'fg.primary', 'fg.secondary', 'fg.muted',
  'accent.primary', 'accent.strong', 'accent.soft', 'accent.companion', 'accent.companionSoft',
  'selection.primary', 'semantic.success', 'semantic.warning', 'semantic.error',
  'scroll.thumb',
  'syntax.comment', 'syntax.keyword', 'syntax.string', 'syntax.number',
  'syntax.function', 'syntax.type', 'syntax.operator',
  'agent.thinking', 'agent.toolCall', 'agent.toolResult',
  'agent.diffAdded', 'agent.diffRemoved', 'agent.userMessage',
] as const;

export type AppColorKey = (typeof APP_COLOR_KEYS)[number];

/** The import/export document shape. */
export interface UnifiedTheme {
  /** Schema version. */
  version: number;
  /** Stable kebab-case id. */
  id: string;
  /** Display name in the picker. */
  name: string;
  /** Light/dark base — selects BASE_LIGHT/BASE_DARK and the Monaco base default. */
  type: 'dark' | 'light';
  author?: string;
  description?: string;
  /** Exact first-paint background for the boot handoff; falls back to bg.canvas. */
  bootBackground?: string;
  /** Partial chrome overrides, merged over BASE_DARK / BASE_LIGHT. */
  app: Partial<Record<AppColorKey, string>>;
  /** Full terminal palette (required — a theme owns its ANSI identity). */
  terminal: TerminalPalette;
  /** Monaco base + optional chrome colors + token rules. */
  editor: {
    base: 'vs' | 'vs-dark';
    colors?: Record<string, string>;
    tokens: EditorTokenRule[];
  };
}

/** Merge an imported theme's partial `app` map over its type's base. */
export function mergeThemeApp(theme: Pick<UnifiedTheme, 'type' | 'app'>): Record<string, string> {
  return { ...(theme.type === 'light' ? BASE_LIGHT : BASE_DARK), ...theme.app };
}

/** Convert a validated UnifiedTheme into the internal ThemeDefinition the
 *  engine, Monaco adapter, and terminal adapter already consume. */
export function unifiedToDefinition(theme: UnifiedTheme): ThemeDefinition {
  const merged = mergeThemeApp(theme);
  // Derived tokens stay derived unless the import overrides them explicitly.
  const accent = merged['accent.primary'];
  const companion = merged['accent.companion'];
  const secondary = merged['fg.secondary'];
  const tokens: Record<string, string> = {
    ...merged,
    'accent.strong': merged['accent.strong'] ?? accent,
    'accent.soft': merged['accent.soft'] ?? rgba(accent, 0.16),
    'accent.companionSoft': merged['accent.companionSoft'] ?? rgba(companion, 0.14),
    'selection.primary': merged['selection.primary'] ?? rgba(accent, 0.32),
    'scroll.thumb': merged['scroll.thumb'] ?? rgba(secondary, 0.34),
  };
  const palette: Record<string, string> = {};
  const semanticTokens: Record<string, { ref: string }> = {};
  for (const [key, value] of Object.entries(tokens)) {
    palette[key] = value;
    semanticTokens[key] = { ref: key };
  }
  return {
    id: theme.id,
    name: theme.name,
    group: 'Cate collection',
    description: theme.description ?? 'Imported theme.',
    mode: theme.type,
    palette,
    semanticTokens,
    artwork: 'official',
    terminal: theme.terminal,
    editor: theme.editor,
    ...(theme.bootBackground ? { bootBackground: theme.bootBackground } : {}),
  };
}

/** Convert a resolved theme back into the portable document for export.
 *  Round-trips through `validateTheme` (T4 in the feature map). */
export function definitionToUnified(resolved: ResolvedTheme): UnifiedTheme {
  const { definition, tokens } = resolved;
  const app: Partial<Record<AppColorKey, string>> = {};
  for (const key of APP_COLOR_KEYS) {
    if (tokens[key]) app[key] = tokens[key];
  }
  return {
    version: THEME_SCHEMA_VERSION,
    id: definition.id,
    name: definition.name,
    type: definition.mode,
    description: definition.description,
    ...(definition.bootBackground ? { bootBackground: definition.bootBackground } : {}),
    app,
    terminal: definition.terminal ?? {
      background: tokens['bg.editor'], foreground: tokens['fg.primary'],
      black: tokens['bg.canvas'], red: tokens['semantic.error'], green: tokens['semantic.success'],
      yellow: tokens['semantic.warning'], blue: tokens['syntax.function'], magenta: tokens['syntax.keyword'],
      cyan: tokens['accent.companion'], white: tokens['fg.primary'],
      brightBlack: tokens['fg.muted'], brightRed: tokens['semantic.error'], brightGreen: tokens['semantic.success'],
      brightYellow: tokens['semantic.warning'], brightBlue: tokens['syntax.function'], brightMagenta: tokens['syntax.keyword'],
      brightCyan: tokens['accent.companion'], brightWhite: tokens['fg.primary'],
    },
    editor: {
      base: definition.editor?.base ?? (definition.mode === 'light' ? 'vs' : 'vs-dark'),
      ...(definition.editor?.colors ? { colors: definition.editor.colors } : {}),
      tokens: definition.editor?.tokens ?? [],
    },
  };
}
