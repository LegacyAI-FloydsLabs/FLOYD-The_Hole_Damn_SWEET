export type ThemeId = 'crush' | 'light';

export type ExtendedColors = Record<string, string>;

export type RoleColors = Record<
  | 'headerTitle'
  | 'headerStatus'
  | 'userLabel'
  | 'assistantLabel'
  | 'systemLabel'
  | 'toolLabel'
  | 'thinking'
  | 'inputPrompt'
  | 'hint',
  string
>;

export type SyntaxColors = Record<
  | 'keywords'
  | 'functions'
  | 'strings'
  | 'numbers'
  | 'comments'
  | 'classes'
  | 'operators'
  | 'punctuation',
  string
>;

export interface DiffColors {
  addition: {
    lineNumber: string;
    symbol: string;
    background: string;
  };
  deletion: {
    lineNumber: string;
    symbol: string;
    background: string;
  };
}

export interface ThemeColors {
  bg: Record<'base' | 'elevated' | 'overlay' | 'modal', string>;
  text: Record<'primary' | 'secondary' | 'tertiary' | 'subtle' | 'selected' | 'inverse', string>;
  accent: Record<'primary' | 'secondary' | 'tertiary' | 'highlight' | 'info', string>;
  status: Record<'ready' | 'working' | 'warning' | 'error' | 'blocked' | 'offline' | 'busy', string>;
  extended: ExtendedColors;
  roles: RoleColors;
  syntax: SyntaxColors;
  diff: DiffColors;
}

export interface Theme {
  id: ThemeId;
  name: string;
  colors: ThemeColors;
}

