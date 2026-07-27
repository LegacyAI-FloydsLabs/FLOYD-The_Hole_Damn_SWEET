import type { Theme } from '@/platform';
import { DEFAULT_THEME_ID, getTheme, isThemeId, nextThemeId, THEMES, type ThemeId } from './presets';
import { ThemeEngine } from './ThemeEngine';
import type { ResolvedTheme, TerminalRendererTheme, ThemeDefinition } from './types';

export { DEFAULT_THEME_ID, getTheme, isThemeId, nextThemeId, THEMES, ThemeEngine };
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
  root.style.colorScheme = 'dark';
  return resolved;
}

export function toPlatformTheme(value: unknown): Theme {
  const resolved = resolveTheme(value);
  const token = (name: string) => resolved.tokens[name];
  return {
    id: resolved.definition.id,
    name: resolved.definition.name,
    isDark: true,
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
  const token = (name: string) => resolved.tokens[name];
  return {
    background: token('bg.editor'), foreground: token('fg.primary'), cursor: token('accent.companion'),
    cursorAccent: token('bg.editor'), selectionBackground: token('selection.primary'), black: token('bg.canvas'),
    red: token('semantic.error'), green: token('semantic.success'), yellow: token('semantic.warning'),
    blue: token('syntax.function'), magenta: token('syntax.keyword'), cyan: token('accent.companion'), white: token('fg.primary'),
  };
}

export function themeArtwork(value: unknown): ThemeDefinition['artwork'] {
  return getTheme(value ?? DEFAULT_THEME_ID).artwork;
}
