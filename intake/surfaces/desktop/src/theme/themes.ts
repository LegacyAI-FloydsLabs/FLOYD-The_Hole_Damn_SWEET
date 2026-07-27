/**
 * Floyd Theme Definitions
 * CRUSH (default dark theme) + Light theme
 * A+ Alignment: 81 colors (22 core + 36 extended + 9 role + 8 syntax + 6 diff)
 */

import type { Theme, ThemeId, ThemeColors, ExtendedColors, RoleColors, SyntaxColors, DiffColors } from './types';

// ============================================================================
// CRUSH THEME (Default - Dark, CharmUI aesthetic)
// ============================================================================

// Extended palette - 31 colors from CharmTone
const CRUSH_EXTENDED: ExtendedColors = {
  // Reds/Pinks
  coral: '#FF577D',
  salmon: '#FF7F90',
  cherry: '#FF3888',
  sriracha: '#EB4268',
  chili: '#E23080',
  bengal: '#FF6E63',
  blush: '#FF84FF',

  // Purples
  violet: '#C259FF',
  mauve: '#D46EFF',
  grape: '#7134DD',
  plum: '#9953FF',
  orchid: '#AD6EFF',
  jelly: '#4A30D9',
  hazy: '#8B75FF',
  prince: '#9C35E1',
  urchin: '#C337E0',

  // Blues
  malibu: '#00A4FF',
  sardine: '#4FBEFE',
  damson: '#007AB8',
  thunder: '#4776FF',
  anchovy: '#719AFC',
  sapphire: '#4949FF',
  guppy: '#7272FF',
  oceania: '#2B55B3',
  ox: '#3331B2',

  // Greens
  guac: '#12C78F',
  julep: '#00FFB2',
  pickle: '#00A475',
  gator: '#18463D',
  spinach: '#1C3634',

  // Yellows
  citron: '#E8FF27',

  // Oranges/Tans
  cumin: '#BF976F',
  tang: '#FF985A',
  yam: '#FFB587',
  paprika: '#D36C64',
  uni: '#FF937D',
};

// Syntax highlighting colors - 8 tokens
const CRUSH_SYNTAX: SyntaxColors = {
  keywords: '#00A4FF',     // accent.info (Malibu)
  functions: '#12C78F',    // status.ready (Guac)
  strings: '#BF976F',      // extended.cumin
  numbers: '#00FFB2',      // extended.julep
  comments: '#706F7B',     // text.subtle (Oyster)
  classes: '#F1EFEF',      // text.selected (Salt)
  operators: '#FF6E63',    // extended.bengal
  punctuation: '#E8FE96',  // accent.highlight (Zest)
};

// Diff view colors - 6 tokens
const CRUSH_DIFF: DiffColors = {
  addition: {
    lineNumber: '#629657',
    symbol: '#629657',
    background: '#323931',
  },
  deletion: {
    lineNumber: '#a45c59',
    symbol: '#a45c59',
    background: '#383030',
  },
};

const CRUSH_COLORS: ThemeColors = {
  // Background colors (Floyd Black & Blue)
  bg: {
    base: '#000000',      // Pure Black
    elevated: '#050505',  // Obsidian
    overlay: '#0A0A0A',   // Near Black
    modal: '#111111',     // Darkest Gray
  },

  // Text colors (High Contrast)
  text: {
    primary: '#FFFFFF',   // White
    secondary: '#CCCCCC', // Light Gray
    tertiary: '#888888',  // Medium Gray
    subtle: '#444444',    // Dark Gray
    selected: '#FFFFFF',  // White
    inverse: '#000000',   // Black
  },

  // Accent colors (Electric Blue Theme)
  accent: {
    primary: '#2E95D3',   // Electric Blue
    secondary: '#00C2FF', // Cyan Blue
    tertiary: '#00E5FF',  // Bright Cyan
    highlight: '#FFFFFF', // White
    info: '#2E95D3',      // Blue
  },

  // Status colors
  status: {
    ready: '#00C2FF',     // Cyan
    working: '#2E95D3',   // Blue
    warning: '#FFCC00',   // Yellow
    error: '#FF4444',     // Red
    blocked: '#444444',   // Dark Gray
    offline: '#222222',   // Charcoal
    busy: '#00E5FF',      // Bright Cyan
  },

  // Extended palette - Mapped to Blues/Blacks
  extended: {
    ...CRUSH_EXTENDED,
    // Override purples/pinks with blues
    violet: '#2E95D3',
    mauve: '#00C2FF',
    grape: '#00E5FF',
    plum: '#2E95D3',
    orchid: '#00C2FF',
    jelly: '#0A0A0A',
    hazy: '#2E95D3',
    prince: '#FFFFFF',
    urchin: '#00C2FF',
    coral: '#FFFFFF',
    salmon: '#E0E0E0',
    cherry: '#00C2FF',
    sriracha: '#FF4444',
    chili: '#FFFFFF',
    bengal: '#FFCC00',
    blush: '#FFFFFF',
  },

  // Role-based semantic colors
  roles: {
    headerTitle: '#00C2FF',    // Cyan Blue
    headerStatus: '#FFFFFF',   // White
    userLabel: '#FFFFFF',      // White
    assistantLabel: '#2E95D3', // Electric Blue
    systemLabel: '#444444',    // Dark Gray
    toolLabel: '#00E5FF',      // Bright Cyan
    thinking: '#2E95D3',       // Blue
    inputPrompt: '#00C2FF',    // Cyan Blue
    hint: '#666666',           // Medium Gray
  },

  // Syntax highlighting colors
  syntax: {
    keywords: '#00C2FF',     // Cyan
    functions: '#FFFFFF',    // White
    strings: '#2E95D3',      // Blue
    numbers: '#00E5FF',      // Bright Cyan
    comments: '#444444',     // Dark Gray
    classes: '#FFFFFF',      // White
    operators: '#FFFFFF',    // White
    punctuation: '#666666',  // Gray
  },

  // Diff view colors
  diff: {
    addition: {
      lineNumber: '#2E95D3',
      symbol: '#2E95D3',
      background: '#001122', // Very dark blue bg
    },
    deletion: {
      lineNumber: '#444444',
      symbol: '#444444',
      background: '#111111', // Dark gray bg
    },
  },
};

// ============================================================================
// LIGHT THEME
// ============================================================================

// Light theme extended colors - same as CRUSH for brand consistency
const LIGHT_EXTENDED: ExtendedColors = { ...CRUSH_EXTENDED };

// Light theme role colors - uses light theme text colors
const LIGHT_ROLES: RoleColors = {
  headerTitle: '#FF60FF',    // accent.secondary (Dolly)
  headerStatus: '#1D1D1F',   // text.primary (dark)
  userLabel: '#12C78F',      // status.ready (Guac)
  assistantLabel: '#00A4FF', // accent.info (Malibu)
  systemLabel: '#E8FE96',    // accent.highlight (Zest)
  toolLabel: '#68FFD6',      // accent.tertiary (Bok)
  thinking: '#E8FE96',       // accent.highlight (Zest)
  inputPrompt: '#12C78F',    // status.ready (Guac)
  hint: '#6E6E73',           // text.secondary (gray)
};

// Light theme syntax colors - same as CRUSH
const LIGHT_SYNTAX: SyntaxColors = { ...CRUSH_SYNTAX };

// Light theme diff colors - same as CRUSH
const LIGHT_DIFF: DiffColors = { ...CRUSH_DIFF };

const LIGHT_COLORS: ThemeColors = {
  // Background colors (Light theme)
  bg: {
    base: '#FFFFFF',
    elevated: '#F5F5F7',
    overlay: '#E5E5EA',
    modal: '#D1D1D6',
  },

  // Text colors
  text: {
    primary: '#1D1D1F',
    secondary: '#6E6E73',
    tertiary: '#86868B',
    subtle: '#A1A1A6',
    selected: '#000000',
    inverse: '#FFFFFF',
  },

  // Accent colors (same as CRUSH for brand consistency)
  accent: {
    primary: '#6B50FF',
    secondary: '#FF60FF',
    tertiary: '#68FFD6',
    highlight: '#E8FE96',
    info: '#00A4FF',
  },

  // Status colors (same as CRUSH)
  status: {
    ready: '#12C78F',
    working: '#6B50FF',
    warning: '#E8FE96',
    error: '#EB4268',
    blocked: '#FF60FF',
    offline: '#858392',
    busy: '#E8FF27',
  },

  // Extended palette - same as CRUSH
  extended: LIGHT_EXTENDED,

  // Role-based colors
  roles: LIGHT_ROLES,

  // Syntax colors
  syntax: LIGHT_SYNTAX,

  // Diff colors
  diff: LIGHT_DIFF,
};

// ============================================================================
// THEME EXPORTS
// ============================================================================

export const THEMES: Record<ThemeId, Theme> = {
  crush: {
    id: 'crush',
    name: 'CRUSH',
    colors: CRUSH_COLORS,
  },
  light: {
    id: 'light',
    name: 'Light',
    colors: LIGHT_COLORS,
  },
};

// Default theme
export const DEFAULT_THEME: ThemeId = 'crush';

// Get theme by ID
export function getTheme(id: ThemeId): Theme {
  return THEMES[id];
}

// Convert theme colors to CSS custom properties
export function themeToCssVariables(theme: Theme): Record<string, string> {
  const { colors } = theme;
  const vars: Record<string, string> = {};

  // Background colors
  vars['--color-bg-base'] = colors.bg.base;
  vars['--color-bg-elevated'] = colors.bg.elevated;
  vars['--color-bg-overlay'] = colors.bg.overlay;
  vars['--color-bg-modal'] = colors.bg.modal;

  // Text colors
  vars['--color-text-primary'] = colors.text.primary;
  vars['--color-text-secondary'] = colors.text.secondary;
  vars['--color-text-tertiary'] = colors.text.tertiary;
  vars['--color-text-subtle'] = colors.text.subtle;
  vars['--color-text-selected'] = colors.text.selected;
  vars['--color-text-inverse'] = colors.text.inverse;

  // Accent colors
  vars['--color-accent-primary'] = colors.accent.primary;
  vars['--color-accent-secondary'] = colors.accent.secondary;
  vars['--color-accent-tertiary'] = colors.accent.tertiary;
  vars['--color-accent-highlight'] = colors.accent.highlight;
  vars['--color-accent-info'] = colors.accent.info;

  // Status colors
  vars['--color-status-ready'] = colors.status.ready;
  vars['--color-status-working'] = colors.status.working;
  vars['--color-status-warning'] = colors.status.warning;
  vars['--color-status-error'] = colors.status.error;
  vars['--color-status-blocked'] = colors.status.blocked;
  vars['--color-status-offline'] = colors.status.offline;
  vars['--color-status-busy'] = colors.status.busy;

  // Extended colors - 31 colors
  Object.entries(colors.extended).forEach(([key, value]) => {
    vars[`--color-extended-${key}`] = value;
  });

  // Role colors - 9 roles
  Object.entries(colors.roles).forEach(([key, value]) => {
    vars[`--color-role-${key}`] = value;
  });

  // Syntax colors - 8 tokens
  Object.entries(colors.syntax).forEach(([key, value]) => {
    vars[`--color-syntax-${key}`] = value;
  });

  // Diff colors - 6 tokens
  vars['--color-diff-addition-line-number'] = colors.diff.addition.lineNumber;
  vars['--color-diff-addition-symbol'] = colors.diff.addition.symbol;
  vars['--color-diff-addition-background'] = colors.diff.addition.background;
  vars['--color-diff-deletion-line-number'] = colors.diff.deletion.lineNumber;
  vars['--color-diff-deletion-symbol'] = colors.diff.deletion.symbol;
  vars['--color-diff-deletion-background'] = colors.diff.deletion.background;

  return vars;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get a color from the theme by key path
 * @param path - Dot-notation path to color (e.g., 'bg.base', 'status.error')
 * @param themeId - The theme to get the color from (defaults to current theme)
 * @returns Color hex string or undefined if not found
 */
export function getColor(path: string, themeId: ThemeId = 'crush'): string | undefined {
  const theme = THEMES[themeId];
  const keys = path.split('.');
  let current: any = theme.colors;

  for (const key of keys) {
    if (current?.[key] !== undefined) {
      current = current[key];
    } else {
      return undefined;
    }
  }

  return typeof current === 'string' ? current : undefined;
}

/**
 * Check if a color exists in the theme
 * @param color - Hex color string to check
 * @param themeId - The theme to check (defaults to crush)
 * @returns True if color is in the theme palette
 */
export function hasColor(color: string, themeId: ThemeId = 'crush'): boolean {
  const theme = THEMES[themeId];
  const allColors = Object.values({
    ...theme.colors.bg,
    ...theme.colors.text,
    ...theme.colors.accent,
    ...theme.colors.status,
    ...theme.colors.extended,
  });

  return allColors.includes(color);
}
