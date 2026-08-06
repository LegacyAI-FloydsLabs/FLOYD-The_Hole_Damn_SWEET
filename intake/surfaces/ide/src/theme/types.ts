export type ThemeGroup = 'Popular dark terminals' | 'CURSEM originals' | 'Product inspired' | 'Cate collection' | 'Light themes';

export type ThemeArtwork = 'official' | 'prism';

export type ThemeModeName = 'dark' | 'light';

export interface TokenRef {
  ref: string;
}

/** A single Monaco token rule. `foreground`/`background` are hex WITHOUT the
 *  leading `#` (Monaco's defineTheme convention). */
export interface EditorTokenRule {
  token: string;
  foreground?: string;
  background?: string;
  fontStyle?: string;
}

/** Editor plane of a unified theme: Monaco base + optional chrome color
 *  overrides + syntax token rules. */
export interface ThemeEditorDefinition {
  base?: 'vs' | 'vs-dark';
  colors?: Record<string, string>;
  tokens?: EditorTokenRule[];
}

/** Full 16-color terminal palette — mirrors xterm's ITheme. Ported from the
 *  Cate unified theme schema (MIT) so every theme carries its own ANSI
 *  identity including the bright half. */
export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  group: ThemeGroup;
  description: string;
  mode: ThemeModeName;
  palette: Record<string, string>;
  semanticTokens: Record<string, TokenRef>;
  artwork: ThemeArtwork;
  /** Full 16-ANSI terminal palette. Always present on catalog themes;
   *  `toTerminalTheme` synthesizes one when a hand-built definition omits it. */
  terminal?: TerminalPalette;
  /** Monaco base + token rules. Always present on catalog themes. */
  editor?: ThemeEditorDefinition;
  /** Exact first-paint background for the boot handoff; falls back to bg.canvas. */
  bootBackground?: string;
}

export interface ResolvedToken {
  value: string;
  contrastRatio?: number;
  contrastPass: boolean;
}

export interface ContrastFailure {
  token: string;
  against: string;
  minimum: number;
  actual: number;
}

export interface ValidationReport {
  valid: boolean;
  errors: string[];
  warnings: string[];
  contrastFailures: ContrastFailure[];
}

export interface ResolvedTheme {
  definition: ThemeDefinition;
  tokens: Record<string, string>;
  report: ValidationReport;
}

export interface TerminalRendererTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}
