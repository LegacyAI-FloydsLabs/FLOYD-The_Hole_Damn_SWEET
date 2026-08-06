// =============================================================================
// Unified theme import validation (ported nearly verbatim from Cate 1.5.3,
// MIT — src/shared/theme.ts validateTheme). Hand-written, dependency-free.
//
// This is the security boundary for theme import: every color value must
// match a narrow color grammar so an imported theme can never smuggle a CSS
// declaration through element.style.setProperty(). Strict on schema version,
// type, id, name, and the full 16-ANSI terminal palette; lenient-by-design on
// unknown `app` keys and malformed token rules (skipped, not fatal).
// =============================================================================

import { APP_COLOR_KEYS, THEME_SCHEMA_VERSION, type AppColorKey, type UnifiedTheme } from './unified';
import type { EditorTokenRule, TerminalPalette } from './types';

/** Largest theme document the import path will parse (feature map §3.4). */
export const MAX_IMPORT_BYTES = 256 * 1024;

/** Accepts hex (#rgb–#rrggbbaa) and rgb()/rgba(). Cate's grammar also allows
 *  bare "r g b" channels for its --agent-rgb var; CURSEM has no such token,
 *  and the ThemeEngine color pattern only accepts hex/rgb(), so the bare form
 *  is rejected here — every validated color must also survive the engine. */
function isCssColor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.length === 0 || text.length > 64) return false;
  if (/^#[0-9a-fA-F]{3,8}$/.test(text)) return true;
  if (/^rgba?\(\s*[0-9.\s,%/]+\)$/.test(text)) return true;
  return false;
}

/** Monaco wants hex without `#`. Accept 6 or 8 hex digits, with/without `#`. */
function normalizeMonacoHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(text) ? text : null;
}

const FONT_STYLE_RE = /^(italic|bold|underline|\s)+$/;
const TERMINAL_ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;

export type ThemeValidation = { ok: true; theme: UnifiedTheme } | { ok: false; error: string };

/**
 * Coerce arbitrary user JSON into a valid UnifiedTheme, or explain why it
 * can't be one. Invalid optional color entries are skipped so imports cannot
 * inject arbitrary CSS; missing required entries produce a per-item error.
 */
export function validateTheme(raw: unknown): ThemeValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Theme must be a JSON object.' };
  }
  const o = raw as Record<string, unknown>;

  if (o.version !== THEME_SCHEMA_VERSION) {
    return { ok: false, error: `Theme schema version must be ${THEME_SCHEMA_VERSION}.` };
  }

  if (o.type !== 'dark' && o.type !== 'light') {
    return { ok: false, error: 'Theme type must be `dark` or `light`.' };
  }
  const type = o.type;

  if (typeof o.name !== 'string' || o.name.length === 0 || o.name.length > 64) {
    return { ok: false, error: 'Theme name must be a non-empty string of at most 64 characters.' };
  }
  const name = o.name;

  if (typeof o.id !== 'string' || o.id.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(o.id)) {
    return { ok: false, error: 'Theme id must be a kebab-case identifier.' };
  }
  const id = o.id;

  // app — keep only known keys with valid color values
  const app: Partial<Record<AppColorKey, string>> = {};
  const rawApp = (o.app && typeof o.app === 'object' ? o.app : {}) as Record<string, unknown>;
  for (const key of APP_COLOR_KEYS) {
    const value = rawApp[key];
    if (value !== undefined && isCssColor(value)) app[key] = value.trim();
  }

  // terminal — require the complete current palette
  const rawTerminal = o.terminal;
  if (!rawTerminal || typeof rawTerminal !== 'object') {
    return { ok: false, error: 'Theme is missing a `terminal` palette.' };
  }
  const t = rawTerminal as Record<string, unknown>;
  if (!isCssColor(t.background) || !isCssColor(t.foreground)) {
    return { ok: false, error: 'terminal.background and terminal.foreground must be colors.' };
  }
  const terminal = {
    background: (t.background as string).trim(),
    foreground: (t.foreground as string).trim(),
  } as TerminalPalette;
  for (const optional of ['cursor', 'cursorAccent', 'selectionBackground', 'selectionForeground'] as const) {
    if (isCssColor(t[optional])) (terminal as unknown as Record<string, string>)[optional] = (t[optional] as string).trim();
  }
  for (const key of TERMINAL_ANSI_KEYS) {
    if (!isCssColor(t[key])) {
      return { ok: false, error: `terminal.${key} must be a color.` };
    }
    terminal[key] = (t[key] as string).trim();
  }

  // editor — base + optional colors + token rules
  if (!o.editor || typeof o.editor !== 'object' || Array.isArray(o.editor)) {
    return { ok: false, error: 'Theme is missing an `editor` palette.' };
  }
  const rawEditor = o.editor as Record<string, unknown>;
  if (rawEditor.base !== 'vs' && rawEditor.base !== 'vs-dark') {
    return { ok: false, error: 'editor.base must be `vs` or `vs-dark`.' };
  }
  if (!Array.isArray(rawEditor.tokens)) {
    return { ok: false, error: 'editor.tokens must be an array.' };
  }
  const editorBase = rawEditor.base;
  const editorColors: Record<string, string> = {};
  if (rawEditor.colors && typeof rawEditor.colors === 'object') {
    for (const [key, value] of Object.entries(rawEditor.colors as Record<string, unknown>)) {
      // Monaco IColors values are #-prefixed hex (with optional alpha).
      if (typeof key === 'string' && /^[\w.]+$/.test(key) && typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value.trim())) {
        editorColors[key] = value.trim();
      }
    }
  }
  const tokens: EditorTokenRule[] = [];
  const rawTokens = Array.isArray(rawEditor.tokens) ? rawEditor.tokens : [];
  for (const rawRule of rawTokens.slice(0, 200)) {
    if (!rawRule || typeof rawRule !== 'object') continue;
    const r = rawRule as Record<string, unknown>;
    if (typeof r.token !== 'string' || !/^[\w.\-, ]+$/.test(r.token)) continue;
    const rule: EditorTokenRule = { token: r.token.slice(0, 80) };
    const foreground = normalizeMonacoHex(r.foreground);
    const background = normalizeMonacoHex(r.background);
    if (foreground) rule.foreground = foreground;
    if (background) rule.background = background;
    if (typeof r.fontStyle === 'string' && FONT_STYLE_RE.test(r.fontStyle.trim())) {
      rule.fontStyle = r.fontStyle.trim();
    }
    tokens.push(rule);
  }

  const bootBackground = isCssColor(o.bootBackground) ? (o.bootBackground as string).trim() : undefined;

  return {
    ok: true,
    theme: {
      version: THEME_SCHEMA_VERSION,
      id,
      name,
      type,
      app,
      terminal,
      editor: { base: editorBase, colors: editorColors, tokens },
      ...(typeof o.author === 'string' ? { author: o.author.slice(0, 80) } : {}),
      ...(typeof o.description === 'string' ? { description: o.description.slice(0, 200) } : {}),
      ...(bootBackground ? { bootBackground } : {}),
    },
  };
}

export interface ThemeImportResult {
  /** Valid themes, with id collisions against `existingIds` renamed (`-2`, `-3`, …). */
  themes: UnifiedTheme[];
  /** Per-document errors, in document order. */
  errors: string[];
}

/** Parse import text (a single theme object or an array of them), validating
 *  each document and renaming id collisions. */
export function parseThemeImport(text: string, existingIds: ReadonlySet<string>): ThemeImportResult {
  if (text.length > MAX_IMPORT_BYTES) {
    return { themes: [], errors: [`Theme file exceeds ${MAX_IMPORT_BYTES} bytes.`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { themes: [], errors: ['File is not valid JSON.'] };
  }
  const documents = Array.isArray(parsed) ? parsed : [parsed];
  const taken = new Set(existingIds);
  const themes: UnifiedTheme[] = [];
  const errors: string[] = [];
  for (const document of documents) {
    const result = validateTheme(document);
    if (!result.ok) {
      errors.push(result.error);
      continue;
    }
    let id = result.theme.id;
    for (let suffix = 2; taken.has(id); suffix++) id = `${result.theme.id}-${suffix}`;
    taken.add(id);
    themes.push({ ...result.theme, id });
  }
  return { themes, errors };
}
