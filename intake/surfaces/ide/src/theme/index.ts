import type { Theme } from '@/platform';
import { DEFAULT_THEME_ID, getTheme, isThemeId, nextThemeId, setCustomThemeDefinitions, THEMES, type ThemeId } from './presets';
import { ThemeEngine } from './ThemeEngine';
import { mixHex } from './makeTheme';
import { unifiedToDefinition } from './unified';
import { validateTheme } from './validate';
import type { ResolvedTheme, TerminalRendererTheme, ThemeDefinition } from './types';

export { DEFAULT_THEME_ID, getTheme, isThemeId, nextThemeId, THEMES, ThemeEngine };
export { APP_COLOR_KEYS, definitionToUnified, mergeThemeApp, THEME_SCHEMA_VERSION, unifiedToDefinition } from './unified';
export { MAX_IMPORT_BYTES, parseThemeImport, validateTheme } from './validate';
export type { UnifiedTheme } from './unified';
export type { ResolvedTheme, TerminalRendererTheme, ThemeDefinition, ThemeId };

const cssVariables: Record<string, string> = {
  'bg.canvas': '--bg-canvas', 'bg.editor': '--bg-editor', 'bg.surface': '--bg-surface', 'bg.raised': '--bg-raised',
  'bg.hover': '--bg-hover', 'bg.active': '--bg-active', 'border.primary': '--border', 'border.strong': '--border-strong',
  'fg.primary': '--text-primary', 'fg.secondary': '--text-secondary', 'fg.muted': '--text-muted',
  'accent.primary': '--accent', 'accent.strong': '--accent-strong', 'accent.soft': '--accent-soft',
  'accent.companion': '--cyan', 'accent.companionSoft': '--cyan-soft', 'border.focus': '--focus',
  'selection.primary': '--selection', 'semantic.success': '--success', 'semantic.warning': '--warning',
  'semantic.error': '--error', 'scroll.thumb': '--scroll-thumb', 'agent.thinking': '--agent-thinking',
  'agent.toolCall': '--agent-tool-call', 'agent.toolResult': '--agent-tool-result', 'agent.diffAdded': '--agent-diff-added',
  'agent.diffRemoved': '--agent-diff-removed', 'agent.userMessage': '--agent-user-message',
};

const resolvedCache = new Map<string, ResolvedTheme>();

/**
 * Register imported user themes with the resolver. Invalid persisted entries
 * are skipped here (never mutated in storage) — resolution simply falls back
 * to the default until a valid theme registers under that id.
 */
export function syncCustomThemes(themes: unknown[]): void {
  const definitions: ThemeDefinition[] = [];
  for (const raw of themes) {
    const result = validateTheme(raw);
    if (result.ok) definitions.push(unifiedToDefinition(result.theme));
  }
  setCustomThemeDefinitions(definitions);
  resolvedCache.clear();
}

function onAccent(background: string): '#09090b' | '#ffffff' {
  const hex = background.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return '#09090b';
  const channels = [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const luminance = channels.reduce((sum, channel, index) => {
    const linear = channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return blackContrast >= whiteContrast ? '#09090b' : '#ffffff';
}

export function resolveTheme(value: unknown): ResolvedTheme {
  const definition = getTheme(value);
  const cached = resolvedCache.get(definition.id);
  if (cached) return cached;
  const engine = new ThemeEngine();
  const report = engine.load(definition);
  const resolved = engine.resolveTheme(report);
  resolvedCache.set(definition.id, resolved);
  return resolved;
}

export function applyThemeToElement(value: unknown, root: HTMLElement): ResolvedTheme {
  const resolved = resolveTheme(value);
  if (!resolved.report.valid) throw new Error(`Theme '${resolved.definition.name}' is invalid: ${resolved.report.errors.join(' ')}`);
  for (const [token, variable] of Object.entries(cssVariables)) {
    const color = resolved.tokens[token];
    if (color) root.style.setProperty(variable, color);
  }
  root.style.setProperty('--on-accent', onAccent(resolved.tokens['accent.primary']));
  root.dataset.theme = resolved.definition.id;
  root.style.colorScheme = resolved.definition.mode;
  return resolved;
}

/**
 * Boot-background handoff (browser analog of Cate's boot.json): the frame
 * parent owns the iframe backdrop, so the renderer publishes the exact
 * first-paint color after every theme application. The value is derived from
 * the resolved theme itself, never from a separately cached copy.
 */
export function publishBootSnapshot(resolved: ResolvedTheme): void {
  const backgroundColor = resolved.definition.bootBackground ?? resolved.tokens['bg.canvas'];
  if (!backgroundColor) return;
  fetch('/api/platform/theme', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      themeId: resolved.definition.id,
      backgroundColor,
      appearance: resolved.definition.mode,
    }),
  }).catch(() => { /* the parent frame falls back to its own backdrop */ });
}

export function toPlatformTheme(value: unknown): Theme {
  const resolved = resolveTheme(value);
  const token = (name: string) => resolved.tokens[name];
  const editor = resolved.definition.editor;
  return {
    id: resolved.definition.id,
    name: resolved.definition.name,
    isDark: resolved.definition.mode === 'dark',
    editorBase: editor?.base ?? (resolved.definition.mode === 'light' ? 'vs' : 'vs-dark'),
    editorRules: editor?.tokens,
    colors: {
      'editor.background': token('bg.editor'),
      'editor.foreground': token('fg.primary'),
      'editorLineNumber.foreground': token('fg.muted'),
      'editorLineNumber.activeForeground': token('fg.secondary'),
      'editorCursor.foreground': token('accent.companion'),
      'editor.selectionBackground': token('selection.primary'),
      'editor.inactiveSelectionBackground': token('accent.soft'),
      'editor.lineHighlightBackground': token('bg.surface'),
      'editorWhitespace.foreground': token('border.primary'),
      'editorIndentGuide.background1': token('border.primary'),
      'editorIndentGuide.activeBackground1': token('accent.primary'),
      ...editor?.colors,
      'syntax.comment': token('syntax.comment'),
      'syntax.keyword': token('syntax.keyword'),
      'syntax.string': token('syntax.string'),
      'syntax.number': token('syntax.number'),
      'syntax.function': token('syntax.function'),
      'syntax.type': token('syntax.type'),
      'syntax.operator': token('syntax.operator'),
    },
  };
}

export function toTerminalTheme(value: unknown): TerminalRendererTheme {
  const resolved = resolveTheme(value);
  const palette = resolved.definition.terminal;
  if (palette) {
    return {
      background: palette.background,
      foreground: palette.foreground,
      cursor: palette.cursor ?? resolved.tokens['accent.companion'],
      cursorAccent: palette.cursorAccent ?? palette.background,
      selectionBackground: palette.selectionBackground ?? resolved.tokens['selection.primary'],
      ...(palette.selectionForeground ? { selectionForeground: palette.selectionForeground } : {}),
      black: palette.black, red: palette.red, green: palette.green, yellow: palette.yellow,
      blue: palette.blue, magenta: palette.magenta, cyan: palette.cyan, white: palette.white,
      brightBlack: palette.brightBlack, brightRed: palette.brightRed, brightGreen: palette.brightGreen,
      brightYellow: palette.brightYellow, brightBlue: palette.brightBlue, brightMagenta: palette.brightMagenta,
      brightCyan: palette.brightCyan, brightWhite: palette.brightWhite,
    };
  }
  // Hand-built definitions without a terminal block: derive the full palette.
  const token = (name: string) => resolved.tokens[name];
  const brighten = (hex: string) => mixHex(hex, resolved.definition.mode === 'light' ? '#000000' : '#ffffff', 0.28);
  return {
    background: token('bg.editor'), foreground: token('fg.primary'), cursor: token('accent.companion'),
    cursorAccent: token('bg.editor'), selectionBackground: token('selection.primary'), black: token('bg.canvas'),
    red: token('semantic.error'), green: token('semantic.success'), yellow: token('semantic.warning'),
    blue: token('syntax.function'), magenta: token('syntax.keyword'), cyan: token('accent.companion'), white: token('fg.primary'),
    brightBlack: mixHex(token('bg.canvas'), token('fg.primary'), 0.45),
    brightRed: brighten(token('semantic.error')), brightGreen: brighten(token('semantic.success')),
    brightYellow: brighten(token('semantic.warning')), brightBlue: brighten(token('syntax.function')),
    brightMagenta: brighten(token('syntax.keyword')), brightCyan: brighten(token('accent.companion')),
    brightWhite: mixHex(token('fg.primary'), resolved.definition.mode === 'light' ? '#000000' : '#ffffff', 0.35),
  };
}

export function themeArtwork(value: unknown): ThemeDefinition['artwork'] {
  return getTheme(value ?? DEFAULT_THEME_ID).artwork;
}
