export const FONT_OPTIONS = [
  {
    id: 'phantasy-mono-pty',
    name: 'Phantasy Mono PTY',
    group: 'CURSEM',
    stack: '"Phantasy Mono PTY", "JetBrains Mono", Menlo, monospace',
    description: 'Bundled CURSEM typeface and workbench default.',
  },
  {
    id: 'menlo',
    name: 'Menlo',
    group: 'Classic terminal',
    stack: 'Menlo, Monaco, monospace',
    description: 'The modern macOS terminal staple.',
  },
  {
    id: 'monaco',
    name: 'Monaco',
    group: 'Classic terminal',
    stack: 'Monaco, Menlo, monospace',
    description: 'The classic Mac coding face.',
  },
  {
    id: 'jetbrains-mono',
    name: 'JetBrains Mono',
    group: 'Classic terminal',
    stack: '"JetBrains Mono", Menlo, monospace',
    description: 'A contemporary developer-focused monospace.',
  },
  {
    id: 'meslo-nerd-font',
    name: 'MesloLGLDZ Nerd Font Mono',
    group: 'Classic terminal',
    stack: '"MesloLGLDZ Nerd Font Mono", "MesloLGLDZ Nerd Font", Menlo, monospace',
    description: 'Meslo with terminal and prompt glyph coverage.',
  },
  {
    id: 'andale-mono',
    name: 'Andale Mono',
    group: 'Classic terminal',
    stack: '"Andale Mono", Menlo, monospace',
    description: 'A long-running terminal and console face.',
  },
  {
    id: 'courier-new',
    name: 'Courier New',
    group: 'Classic terminal',
    stack: '"Courier New", Courier, monospace',
    description: 'A widely available fixed-width classic.',
  },
  {
    id: 'courier',
    name: 'Courier',
    group: 'Classic terminal',
    stack: 'Courier, "Courier New", monospace',
    description: 'The original typewriter-style terminal fallback.',
  },
  {
    id: 'pt-mono',
    name: 'PT Mono',
    group: 'Classic terminal',
    stack: '"PT Mono", Menlo, monospace',
    description: 'A compact fixed-width terminal alternative.',
  },
  {
    id: 'helvetica-neue',
    name: 'Helvetica Neue',
    group: 'Standard',
    stack: '"Helvetica Neue", Helvetica, Arial, sans-serif',
    description: 'A standard macOS interface face.',
  },
  {
    id: 'arial',
    name: 'Arial',
    group: 'Standard',
    stack: 'Arial, Helvetica, sans-serif',
    description: 'A broadly available standard sans serif.',
  },
] as const;

export type FontId = (typeof FONT_OPTIONS)[number]['id'];
export type FontGroup = (typeof FONT_OPTIONS)[number]['group'];

export const DEFAULT_FONT_ID: FontId = 'phantasy-mono-pty';

export function isFontId(value: unknown): value is FontId {
  return typeof value === 'string' && FONT_OPTIONS.some((font) => font.id === value);
}

export function resolveFont(value: unknown) {
  return FONT_OPTIONS.find((font) => font.id === value) ?? FONT_OPTIONS[0];
}

export function fontStack(value: unknown): string {
  return resolveFont(value).stack;
}
