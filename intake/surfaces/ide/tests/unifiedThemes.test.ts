import { afterEach, describe, expect, it } from 'vitest';
import {
  applyThemeToElement, DEFAULT_THEME_ID, getTheme, resolveTheme, syncCustomThemes, THEMES,
  toPlatformTheme, toTerminalTheme, validateTheme, type UnifiedTheme,
} from '@/theme';

const ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;

describe('unified theme catalog', () => {
  afterEach(() => syncCustomThemes([]));

  it('ships the CURSEM presets plus the Cate port collection, dark and light', () => {
    expect(THEMES).toHaveLength(26);
    expect(THEMES.filter((theme) => theme.group === 'Popular dark terminals')).toHaveLength(12);
    expect(THEMES.filter((theme) => theme.group === 'Cate collection')).toHaveLength(4);
    expect(THEMES.filter((theme) => theme.group === 'Light themes')).toHaveLength(4);
    expect(THEMES.filter((theme) => theme.mode === 'light').length).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_THEME_ID).toBe('tokyo-night');
  });

  it.each(THEMES)('$name resolves with valid contrast and a full three-plane payload', (theme) => {
    const resolved = resolveTheme(theme.id);
    expect(resolved.report.errors).toEqual([]);
    expect(resolved.report.contrastFailures).toEqual([]);

    // Terminal plane: a complete 16-color ANSI palette per theme.
    const terminal = toTerminalTheme(theme.id);
    for (const key of ANSI_KEYS) {
      expect(terminal[key], `terminal.${key}`).toMatch(/^#[0-9a-f]{6}$/i);
    }

    // Editor plane: Monaco base + token rules (hex-without-# foregrounds).
    // Some Cate ports ship `tokens: []` and intentionally inherit the Monaco
    // base's rules — the block must exist, the rules must be well-formed.
    const editor = toPlatformTheme(theme.id);
    expect(editor.isDark).toBe(theme.mode === 'dark');
    expect(editor.editorBase).toBe(theme.mode === 'light' ? 'vs' : 'vs-dark');
    expect(Array.isArray(editor.editorRules)).toBe(true);
    for (const rule of editor.editorRules ?? []) {
      if (rule.foreground) expect(rule.foreground).toMatch(/^[0-9a-f]{6}([0-9a-f]{2})?$/i);
    }
  });

  it('carries full Monaco token rules for themes that define them', () => {
    const rules = toPlatformTheme('tokyo-night').editorRules ?? [];
    expect(rules.length).toBeGreaterThan(10);
    expect(rules.find((rule) => rule.token === 'comment')).toMatchObject({ foreground: '565f89', fontStyle: 'italic' });
  });

  it('gives enhanced presets their authentic Cate ANSI identity', () => {
    // Tokyo Night's Cate terminal palette, not a chrome-derived approximation.
    expect(toTerminalTheme('tokyo-night').brightBlack).toBe('#5e6997');
    expect(toTerminalTheme('tokyo-night').cyan).toBe('#7dcfff');
  });

  it('resolves custom themes first, then built-ins, then the default', () => {
    const custom: UnifiedTheme = {
      version: 1,
      id: 'olive-custom',
      name: 'Olive Custom',
      type: 'dark',
      app: { 'bg.editor': '#101410' },
      terminal: {
        background: '#101410', foreground: '#e8f0e4',
        black: '#0a0d0a', red: '#e06c75', green: '#98c379', yellow: '#d19a66',
        blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
        brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#d19a66',
        brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
      },
      editor: { base: 'vs-dark', tokens: [{ token: 'keyword', foreground: '98c379' }] },
    };
    expect(validateTheme(custom).ok).toBe(true);

    // Unknown ids fall back before registration, resolve after.
    expect(getTheme('olive-custom').id).toBe(DEFAULT_THEME_ID);
    syncCustomThemes([custom]);
    expect(getTheme('olive-custom').id).toBe('olive-custom');

    const resolved = resolveTheme('olive-custom');
    expect(resolved.report.valid).toBe(true);
    // Partial app map merged over BASE_DARK: override wins, base fills the rest.
    expect(resolved.tokens['bg.editor']).toBe('#101410');
    expect(resolved.tokens['accent.primary']).toBe('#f72585');

    expect(toPlatformTheme('olive-custom').editorRules?.[0]).toEqual({ token: 'keyword', foreground: '98c379' });
    expect(toTerminalTheme('olive-custom').brightCyan).toBe('#56b6c2');

    // Validated imports must survive the engine at apply time (no throw).
    const root = document.createElement('div');
    expect(() => applyThemeToElement('olive-custom', root)).not.toThrow();
    expect(root.dataset.theme).toBe('olive-custom');
    expect(root.style.getPropertyValue('--bg-editor')).toBe('#101410');

    syncCustomThemes([]);
    expect(getTheme('olive-custom').id).toBe(DEFAULT_THEME_ID);
  });

  it('skips invalid persisted custom themes at registration without throwing', () => {
    syncCustomThemes([{ name: 'Legacy Shape' }, null, 42]);
    expect(getTheme('anything')).toBe(getTheme(DEFAULT_THEME_ID));
  });
});
