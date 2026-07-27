export type ThemeGroup = 'Popular dark terminals' | 'CURSEM originals' | 'Product inspired';

export type ThemeArtwork = 'official' | 'prism';

export interface TokenRef {
  ref: string;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  group: ThemeGroup;
  description: string;
  mode: 'dark';
  palette: Record<string, string>;
  semanticTokens: Record<string, TokenRef>;
  artwork: ThemeArtwork;
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
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
}
