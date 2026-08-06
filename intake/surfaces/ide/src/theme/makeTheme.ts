import type { TerminalPalette, ThemeArtwork, ThemeDefinition, ThemeEditorDefinition, ThemeGroup, ThemeModeName } from './types';

const semanticTokens = {
  'bg.canvas': { ref: 'canvas' },
  'bg.editor': { ref: 'editor' },
  'bg.surface': { ref: 'surface' },
  'bg.raised': { ref: 'raised' },
  'bg.hover': { ref: 'hover' },
  'bg.active': { ref: 'active' },
  'border.primary': { ref: 'border' },
  'border.strong': { ref: 'borderStrong' },
  'fg.primary': { ref: 'text' },
  'fg.secondary': { ref: 'secondary' },
  'fg.muted': { ref: 'muted' },
  'accent.primary': { ref: 'accent' },
  'accent.strong': { ref: 'accentStrong' },
  'accent.soft': { ref: 'accentSoft' },
  'accent.companion': { ref: 'companion' },
  'accent.companionSoft': { ref: 'companionSoft' },
  'border.focus': { ref: 'companion' },
  'selection.primary': { ref: 'selection' },
  'semantic.success': { ref: 'success' },
  'semantic.warning': { ref: 'warning' },
  'semantic.error': { ref: 'error' },
  'scroll.thumb': { ref: 'scrollThumb' },
  'syntax.comment': { ref: 'comment' },
  'syntax.keyword': { ref: 'keyword' },
  'syntax.string': { ref: 'string' },
  'syntax.number': { ref: 'number' },
  'syntax.function': { ref: 'function' },
  'syntax.type': { ref: 'type' },
  'syntax.operator': { ref: 'operator' },
  'agent.thinking': { ref: 'muted' },
  'agent.toolCall': { ref: 'warning' },
  'agent.toolResult': { ref: 'secondary' },
  'agent.diffAdded': { ref: 'success' },
  'agent.diffRemoved': { ref: 'error' },
  'agent.userMessage': { ref: 'companion' },
} as const;

interface ThemeColors {
  canvas: string;
  editor: string;
  surface: string;
  raised: string;
  hover: string;
  active: string;
  border: string;
  borderStrong: string;
  text: string;
  secondary: string;
  muted: string;
  accent: string;
  accentStrong?: string;
  companion: string;
  success: string;
  warning: string;
  error: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  function: string;
  type: string;
  operator: string;
}

export interface ThemeInput<Id extends string> {
  id: Id;
  name: string;
  group: ThemeGroup;
  description: string;
  mode?: ThemeModeName;
  colors: ThemeColors;
  artwork?: ThemeArtwork;
  /** Exact terminal palette; synthesized from `colors` when omitted. */
  terminal?: TerminalPalette;
  /** Monaco base + token rules; synthesized from `colors` when omitted. */
  editor?: ThemeEditorDefinition;
  bootBackground?: string;
}

export function rgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const normalized = value.length === 3 ? value.split('').map((part) => `${part}${part}`).join('') : value;
  const number = Number.parseInt(normalized, 16);
  return `rgba(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`;
}

/** Mix two hex colors: amount 0 keeps `hex`, 1 lands on `target`. */
export function mixHex(hex: string, target: string, amount: number): string {
  const parse = (value: string) => {
    const source = value.replace('#', '');
    const normalized = source.length === 3 ? source.split('').map((part) => `${part}${part}`).join('') : source;
    const number = Number.parseInt(normalized, 16);
    return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
  };
  const a = parse(hex);
  const b = parse(target);
  const channel = (index: number) => Math.round(a[index] + (b[index] - a[index]) * amount);
  return `#${[channel(0), channel(1), channel(2)].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

/** Derive a full 16-ANSI palette from a theme's base colors. Catalog themes
 *  ported from Cate carry an exact palette instead (see cateThemes.ts). */
function synthesizeTerminal(colors: ThemeColors, mode: ThemeModeName): TerminalPalette {
  const brighten = (hex: string) => mixHex(hex, mode === 'light' ? '#000000' : '#ffffff', 0.28);
  return {
    background: colors.editor,
    foreground: colors.text,
    cursor: colors.companion,
    cursorAccent: colors.editor,
    selectionBackground: rgba(colors.accent, 0.32),
    black: colors.canvas,
    red: colors.error,
    green: colors.success,
    yellow: colors.warning,
    blue: colors.function,
    magenta: colors.keyword,
    cyan: colors.companion,
    white: colors.text,
    brightBlack: mixHex(colors.canvas, colors.text, 0.45),
    brightRed: brighten(colors.error),
    brightGreen: brighten(colors.success),
    brightYellow: brighten(colors.warning),
    brightBlue: brighten(colors.function),
    brightMagenta: brighten(colors.keyword),
    brightCyan: brighten(colors.companion),
    brightWhite: mixHex(colors.text, mode === 'light' ? '#000000' : '#ffffff', 0.35),
  };
}

/** Derive Monaco token rules from the theme's syntax colors. */
function synthesizeEditor(colors: ThemeColors, mode: ThemeModeName): ThemeEditorDefinition {
  const strip = (hex: string) => hex.replace('#', '');
  return {
    base: mode === 'light' ? 'vs' : 'vs-dark',
    tokens: [
      { token: 'comment', foreground: strip(colors.comment), fontStyle: 'italic' },
      { token: 'keyword', foreground: strip(colors.keyword) },
      { token: 'storage', foreground: strip(colors.keyword) },
      { token: 'string', foreground: strip(colors.string) },
      { token: 'constant.numeric', foreground: strip(colors.number) },
      { token: 'constant.language', foreground: strip(colors.number) },
      { token: 'entity.name.function', foreground: strip(colors.function) },
      { token: 'support.function', foreground: strip(colors.function) },
      { token: 'entity.name.type', foreground: strip(colors.type) },
      { token: 'entity.name.class', foreground: strip(colors.type) },
      { token: 'operator', foreground: strip(colors.operator) },
    ],
  };
}

export function makeTheme<const Id extends string>(input: ThemeInput<Id>): ThemeDefinition & { id: Id } {
  const accentStrong = input.colors.accentStrong ?? input.colors.accent;
  const mode = input.mode ?? 'dark';
  return {
    id: input.id,
    name: input.name,
    group: input.group,
    description: input.description,
    mode,
    artwork: input.artwork ?? 'official',
    palette: {
      ...input.colors,
      accentStrong,
      accentSoft: rgba(input.colors.accent, 0.16),
      companionSoft: rgba(input.colors.companion, 0.14),
      selection: rgba(input.colors.accent, 0.32),
      scrollThumb: rgba(input.colors.secondary, 0.34),
    },
    semanticTokens,
    terminal: input.terminal ?? synthesizeTerminal(input.colors, mode),
    editor: input.editor ?? synthesizeEditor(input.colors, mode),
    ...(input.bootBackground ? { bootBackground: input.bootBackground } : {}),
  };
}
