import { describe, expect, it } from 'vitest';
import { parseThemeImport, validateTheme, THEME_SCHEMA_VERSION, type UnifiedTheme } from '@/theme';

function validTheme(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: THEME_SCHEMA_VERSION,
    id: 'olive-custom',
    name: 'Olive Custom',
    type: 'dark',
    app: { 'bg.editor': '#101410', 'fg.primary': '#e8f0e4' },
    terminal: {
      background: '#101410', foreground: '#e8f0e4',
      black: '#0a0d0a', red: '#e06c75', green: '#98c379', yellow: '#d19a66',
      blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
      brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#d19a66',
      brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
    },
    editor: { base: 'vs-dark', tokens: [{ token: 'comment', foreground: '5c6370', fontStyle: 'italic' }] },
    ...overrides,
  };
}

describe('unified theme import validation', () => {
  it('accepts a well-formed theme document', () => {
    const result = validateTheme(validTheme());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.theme.id).toBe('olive-custom');
      expect(result.theme.terminal.brightBlack).toBe('#5c6370');
      expect(result.theme.editor.tokens[0]).toEqual({ token: 'comment', foreground: '5c6370', fontStyle: 'italic' });
    }
  });

  it('rejects wrong schema versions, types, and malformed ids', () => {
    expect(validateTheme(validTheme({ version: 2 }))).toMatchObject({ ok: false });
    expect(validateTheme(validTheme({ type: 'sepia' }))).toMatchObject({ ok: false });
    expect(validateTheme(validTheme({ id: 'Not Kebab!' }))).toMatchObject({ ok: false });
    expect(validateTheme(validTheme({ name: '' }))).toMatchObject({ ok: false });
    expect(validateTheme('not an object')).toMatchObject({ ok: false });
  });

  it('requires the full 16-ANSI terminal palette', () => {
    const theme = validTheme();
    const terminal = theme.terminal as Record<string, unknown>;
    delete terminal.brightCyan;
    const result = validateTheme(theme);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain('terminal.brightCyan');
  });

  it('drops CSS-injection attempts instead of carrying them', () => {
    const result = validateTheme(validTheme({
      app: {
        'bg.editor': '#101410',
        'fg.primary': 'red; } body { display: none; } /*',
        'accent.primary': 'url(javascript:alert(1))',
        'not-a-real-token': '#ffffff',
      },
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.theme.app['bg.editor']).toBe('#101410');
      expect(result.theme.app['fg.primary']).toBeUndefined();
      expect(result.theme.app['accent.primary']).toBeUndefined();
      expect('not-a-real-token' in result.theme.app).toBe(false);
    }
  });

  it('caps token rules at 200 and skips malformed rules', () => {
    const tokens = Array.from({ length: 250 }, (_, index) => ({ token: `scope.${index}`, foreground: 'aabbcc' }));
    const result = validateTheme(validTheme({
      editor: { base: 'vs-dark', tokens: [...tokens, { token: 'bad token!!' }, { noToken: true }] },
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.theme.editor.tokens).toHaveLength(200);
      expect(result.theme.editor.tokens.every((rule) => /^[\w.\-, ]+$/.test(rule.token))).toBe(true);
    }
  });

  it('parses single documents and arrays, renaming id collisions', () => {
    const single = parseThemeImport(JSON.stringify(validTheme()), new Set());
    expect(single.errors).toEqual([]);
    expect(single.themes.map((theme) => theme.id)).toEqual(['olive-custom']);

    const array = parseThemeImport(JSON.stringify([validTheme(), validTheme(), validTheme({ id: 'tokyo-night' })]), new Set(['tokyo-night']));
    expect(array.themes.map((theme) => theme.id)).toEqual(['olive-custom', 'olive-custom-2', 'tokyo-night-2']);
  });

  it('reports per-document errors without sinking valid themes', () => {
    const { themes, errors } = parseThemeImport(JSON.stringify([validTheme({ version: 99 }), validTheme()]), new Set());
    expect(themes).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('schema version');

    expect(parseThemeImport('{ not json', new Set()).errors[0]).toContain('not valid JSON');
    expect(parseThemeImport('x'.repeat(300 * 1024), new Set()).errors[0]).toContain('exceeds');
  });

  it('round-trips an exported catalog theme through the validator', async () => {
    const { definitionToUnified, resolveTheme } = await import('@/theme');
    const exported: UnifiedTheme = definitionToUnified(resolveTheme('light-subtle'));
    const result = validateTheme(JSON.parse(JSON.stringify(exported)));
    expect(result).toMatchObject({ ok: true });
  });
});
