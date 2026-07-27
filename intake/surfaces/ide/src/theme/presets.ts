import type { ThemeArtwork, ThemeDefinition, ThemeGroup } from './types';

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

interface ThemeInput<Id extends string> {
  id: Id;
  name: string;
  group: ThemeGroup;
  description: string;
  colors: ThemeColors;
  artwork?: ThemeArtwork;
}

function rgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const normalized = value.length === 3 ? value.split('').map((part) => `${part}${part}`).join('') : value;
  const number = Number.parseInt(normalized, 16);
  return `rgba(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`;
}

function makeTheme<const Id extends string>(input: ThemeInput<Id>): ThemeDefinition & { id: Id } {
  const accentStrong = input.colors.accentStrong ?? input.colors.accent;
  return {
    id: input.id,
    name: input.name,
    group: input.group,
    description: input.description,
    mode: 'dark',
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
  };
}

const popular = 'Popular dark terminals' as const;
const floyd = 'CURSEM originals' as const;
const product = 'Product inspired' as const;

export const THEMES = [
  makeTheme({ id: 'tokyo-night', name: 'Tokyo Night', group: popular, description: 'Cool midnight blue with neon city accents.', colors: { canvas: '#16161e', editor: '#1a1b26', surface: '#1f2335', raised: '#24283b', hover: '#292e42', active: '#3b4261', border: '#292e42', borderStrong: '#3b4261', text: '#c0caf5', secondary: '#a9b1d6', muted: '#565f89', accent: '#7aa2f7', accentStrong: '#89b4fa', companion: '#bb9af7', success: '#9ece6a', warning: '#e0af68', error: '#f7768e', comment: '#565f89', keyword: '#bb9af7', string: '#9ece6a', number: '#ff9e64', function: '#7aa2f7', type: '#2ac3de', operator: '#89ddff' } }),
  makeTheme({ id: 'dracula', name: 'Dracula', group: popular, description: 'The canonical purple, pink, and cyan dark palette.', colors: { canvas: '#21222c', editor: '#282a36', surface: '#282a36', raised: '#343746', hover: '#3c3f50', active: '#44475a', border: '#44475a', borderStrong: '#6272a4', text: '#f8f8f2', secondary: '#d7d7d2', muted: '#6272a4', accent: '#bd93f9', companion: '#8be9fd', success: '#50fa7b', warning: '#f1fa8c', error: '#ff5555', comment: '#6272a4', keyword: '#ff79c6', string: '#f1fa8c', number: '#bd93f9', function: '#50fa7b', type: '#8be9fd', operator: '#ff79c6' } }),
  makeTheme({ id: 'catppuccin-mocha', name: 'Catppuccin Mocha', group: popular, description: 'Soft high-contrast pastels over layered espresso surfaces.', colors: { canvas: '#11111b', editor: '#1e1e2e', surface: '#181825', raised: '#313244', hover: '#363a4f', active: '#45475a', border: '#313244', borderStrong: '#585b70', text: '#cdd6f4', secondary: '#bac2de', muted: '#6c7086', accent: '#cba6f7', companion: '#89dceb', success: '#a6e3a1', warning: '#f9e2af', error: '#f38ba8', comment: '#6c7086', keyword: '#cba6f7', string: '#a6e3a1', number: '#fab387', function: '#89b4fa', type: '#f9e2af', operator: '#94e2d5' } }),
  makeTheme({ id: 'one-dark', name: 'One Dark', group: popular, description: 'Atom-derived charcoal with balanced syntax colors.', colors: { canvas: '#21252b', editor: '#282c34', surface: '#21252b', raised: '#2c313c', hover: '#333842', active: '#3e4451', border: '#3e4451', borderStrong: '#4b5263', text: '#abb2bf', secondary: '#9da5b4', muted: '#5c6370', accent: '#61afef', companion: '#c678dd', success: '#98c379', warning: '#e5c07b', error: '#e06c75', comment: '#5c6370', keyword: '#c678dd', string: '#98c379', number: '#d19a66', function: '#61afef', type: '#e5c07b', operator: '#56b6c2' } }),
  makeTheme({ id: 'gruvbox-dark', name: 'Gruvbox Dark', group: popular, description: 'Warm retro contrast with earthy terminal colors.', colors: { canvas: '#1d2021', editor: '#282828', surface: '#242424', raised: '#32302f', hover: '#3c3836', active: '#504945', border: '#3c3836', borderStrong: '#665c54', text: '#ebdbb2', secondary: '#d5c4a1', muted: '#928374', accent: '#fabd2f', companion: '#83a598', success: '#b8bb26', warning: '#fe8019', error: '#fb4934', comment: '#928374', keyword: '#fb4934', string: '#b8bb26', number: '#d3869b', function: '#fabd2f', type: '#83a598', operator: '#8ec07c' } }),
  makeTheme({ id: 'nord', name: 'Nord', group: popular, description: 'Arctic blue-gray surfaces with restrained frost accents.', colors: { canvas: '#242933', editor: '#2e3440', surface: '#2b303b', raised: '#3b4252', hover: '#414957', active: '#4c566a', border: '#3b4252', borderStrong: '#4c566a', text: '#eceff4', secondary: '#d8dee9', muted: '#7b88a1', accent: '#88c0d0', companion: '#81a1c1', success: '#a3be8c', warning: '#ebcb8b', error: '#bf616a', comment: '#7b88a1', keyword: '#b48ead', string: '#a3be8c', number: '#d08770', function: '#88c0d0', type: '#8fbcbb', operator: '#81a1c1' } }),
  makeTheme({ id: 'solarized-dark', name: 'Solarized Dark', group: popular, description: 'Low-fatigue blue-green contrast from the classic Solarized scale.', colors: { canvas: '#00212b', editor: '#002b36', surface: '#073642', raised: '#0b3b46', hover: '#124854', active: '#1b5662', border: '#124854', borderStrong: '#586e75', text: '#fdf6e3', secondary: '#eee8d5', muted: '#839496', accent: '#268bd2', accentStrong: '#55a7df', companion: '#2aa198', success: '#859900', warning: '#b58900', error: '#dc322f', comment: '#839496', keyword: '#859900', string: '#2aa198', number: '#d33682', function: '#268bd2', type: '#b58900', operator: '#6c71c4' } }),
  makeTheme({ id: 'monokai', name: 'Monokai', group: popular, description: 'High-energy green, pink, and amber on warm charcoal.', colors: { canvas: '#1e1f1c', editor: '#272822', surface: '#20211d', raised: '#32332d', hover: '#3a3b34', active: '#49483e', border: '#3e3d32', borderStrong: '#75715e', text: '#f8f8f2', secondary: '#d8d8d2', muted: '#75715e', accent: '#a6e22e', companion: '#66d9ef', success: '#a6e22e', warning: '#e6db74', error: '#f92672', comment: '#75715e', keyword: '#f92672', string: '#e6db74', number: '#ae81ff', function: '#a6e22e', type: '#66d9ef', operator: '#f92672' } }),
  makeTheme({ id: 'ayu-mirage', name: 'Ayu Mirage', group: popular, description: 'Smoky navy with calm amber and cyan syntax.', colors: { canvas: '#171b24', editor: '#1f2430', surface: '#191e2a', raised: '#252b37', hover: '#2b3240', active: '#343e4f', border: '#303846', borderStrong: '#46536b', text: '#cccac2', secondary: '#b8b6af', muted: '#707a8c', accent: '#ffcc66', companion: '#5ccfe6', success: '#bae67e', warning: '#ffd580', error: '#ff6666', comment: '#707a8c', keyword: '#ffa759', string: '#bae67e', number: '#d4bfff', function: '#ffd580', type: '#5ccfe6', operator: '#f29e74' } }),
  makeTheme({ id: 'kanagawa-wave', name: 'Kanagawa Wave', group: popular, description: 'Ink-dark Japanese palette with muted wave blues.', colors: { canvas: '#16161d', editor: '#1f1f28', surface: '#16161d', raised: '#2a2a37', hover: '#30303f', active: '#363646', border: '#2a2a37', borderStrong: '#54546d', text: '#dcd7ba', secondary: '#c8c093', muted: '#727169', accent: '#7e9cd8', companion: '#7fb4ca', success: '#98bb6c', warning: '#e6c384', error: '#e46876', comment: '#727169', keyword: '#957fb8', string: '#98bb6c', number: '#d27e99', function: '#7e9cd8', type: '#7aa89f', operator: '#c0a36e' } }),
  makeTheme({ id: 'floyd', name: 'CURSEM Neon', group: floyd, description: 'Neon cyan and hot pink sampled from the CURSEM mark.', colors: { canvas: '#08070d', editor: '#0b0912', surface: '#100e18', raised: '#17141f', hover: '#211d2b', active: '#292236', border: '#302a3b', borderStrong: '#44394f', text: '#ebe8ef', secondary: '#aaa4b5', muted: '#777184', accent: '#f72585', accentStrong: '#ff4a9b', companion: '#25d9f5', success: '#51d59a', warning: '#f4c464', error: '#ff6b83', comment: '#777184', keyword: '#ff5fa2', string: '#77e7f5', number: '#c09bff', function: '#73B9FF', type: '#ffe08a', operator: '#25d9f5' } }),
  makeTheme({ id: 'floyd-flipped', name: 'CURSEM Inverse', group: floyd, description: 'The CURSEM palette with cyan and pink authority reversed.', colors: { canvas: '#060a0d', editor: '#071014', surface: '#0b171c', raised: '#102128', hover: '#162c34', active: '#1c3942', border: '#24414a', borderStrong: '#315963', text: '#e8f0f1', secondary: '#a4b5b8', muted: '#6f858a', accent: '#25d9f5', accentStrong: '#62edff', companion: '#f72585', success: '#51d59a', warning: '#f4c464', error: '#ff6480', comment: '#6f858a', keyword: '#25d9f5', string: '#ff6aaa', number: '#80e8f6', function: '#f72585', type: '#ffe08a', operator: '#62edff' } }),
  makeTheme({ id: 'cursor', name: 'Cursor', group: product, description: 'Minimal near-black editor chrome with cool electric focus.', colors: { canvas: '#0e0e0e', editor: '#141414', surface: '#181818', raised: '#202020', hover: '#282828', active: '#303030', border: '#2b2b2b', borderStrong: '#454545', text: '#eeeeee', secondary: '#b7b7b7', muted: '#777777', accent: '#6e8cff', companion: '#8cb4ff', success: '#74c991', warning: '#e5c07b', error: '#f07178', comment: '#777777', keyword: '#c792ea', string: '#c3e88d', number: '#f78c6c', function: '#82aaff', type: '#ffcb6b', operator: '#89ddff' } }),
  makeTheme({ id: 'claude', name: 'Claude', group: product, description: 'Warm charcoal, parchment text, and terracotta emphasis.', colors: { canvas: '#171613', editor: '#1f1e1b', surface: '#24221e', raised: '#2c2a25', hover: '#35322c', active: '#403c35', border: '#3b3831', borderStrong: '#5a554b', text: '#f0eadf', secondary: '#c9c0b2', muted: '#8f877b', accent: '#d97757', companion: '#e7b67c', success: '#8fb573', warning: '#e7b67c', error: '#df6f68', comment: '#8f877b', keyword: '#d97757', string: '#a9c181', number: '#e7b67c', function: '#e3a86d', type: '#c9a0dc', operator: '#d8c3a5' } }),
  makeTheme({ id: 'github-dark', name: 'GitHub Dark', group: product, description: 'GitHub’s restrained dark canvas and accessible status colors.', colors: { canvas: '#010409', editor: '#0d1117', surface: '#161b22', raised: '#21262d', hover: '#292e36', active: '#30363d', border: '#30363d', borderStrong: '#484f58', text: '#f0f6fc', secondary: '#c9d1d9', muted: '#8b949e', accent: '#58a6ff', companion: '#79c0ff', success: '#3fb950', warning: '#d29922', error: '#f85149', comment: '#8b949e', keyword: '#ff7b72', string: '#a5d6ff', number: '#79c0ff', function: '#d2a8ff', type: '#ffa657', operator: '#ff7b72' } }),
  makeTheme({ id: 'deep-black', name: 'Deep Black', group: product, description: 'OLED black with spectral accents and prism artwork.', artwork: 'prism', colors: { canvas: '#000000', editor: '#000000', surface: '#050505', raised: '#0b0b0b', hover: '#141414', active: '#1d1d1d', border: '#242424', borderStrong: '#454545', text: '#ffffff', secondary: '#d4d4d4', muted: '#858585', accent: '#e7e7e7', accentStrong: '#ffffff', companion: '#42d9ff', success: '#54e58b', warning: '#ffd84a', error: '#ff5151', comment: '#858585', keyword: '#ff4f9a', string: '#54e58b', number: '#ff9f43', function: '#42d9ff', type: '#b783ff', operator: '#ffd84a' } }),
] as const;

export type ThemeId = typeof THEMES[number]['id'];

export const DEFAULT_THEME_ID: ThemeId = 'tokyo-night';

const themeMap = new Map<string, ThemeDefinition>(THEMES.map((theme) => [theme.id, theme]));

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && themeMap.has(value);
}

export function getTheme(value: unknown): ThemeDefinition {
  return (typeof value === 'string' ? themeMap.get(value) : undefined) ?? themeMap.get(DEFAULT_THEME_ID)!;
}

export function nextThemeId(value: unknown): ThemeId {
  const current = getTheme(value);
  const index = THEMES.findIndex((theme) => theme.id === current.id);
  return THEMES[(index + 1) % THEMES.length].id;
}
