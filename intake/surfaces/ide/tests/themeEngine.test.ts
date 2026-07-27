import { describe, expect, it } from 'vitest';
import { applyThemeToElement, DEFAULT_THEME_ID, getTheme, resolveTheme, THEMES, ThemeEngine, toPlatformTheme, toTerminalTheme } from '@/theme';

describe('CURSE\'M semantic theme engine', () => {
  it('ships ten curated popular dark presets plus six requested originals', () => {
    expect(THEMES).toHaveLength(16);
    expect(THEMES.filter((theme) => theme.group === 'Popular dark terminals')).toHaveLength(10);
    expect(THEMES.map((theme) => theme.name)).toEqual(expect.arrayContaining([
      'Tokyo Night', 'Dracula', 'Catppuccin Mocha', 'One Dark', 'Gruvbox Dark', 'Nord',
      'Solarized Dark', 'Monokai', 'Ayu Mirage', 'Kanagawa Wave', 'CURSEM Neon', 'CURSEM Inverse',
      'Cursor', 'Claude', 'GitHub Dark', 'Deep Black',
    ]));
    expect(DEFAULT_THEME_ID).toBe('tokyo-night');
  });

  it.each(THEMES)('validates $name and its primary contrast targets', (theme) => {
    const resolved = resolveTheme(theme.id);
    expect(resolved.report.errors).toEqual([]);
    expect(resolved.report.contrastFailures).toEqual([]);
  });

  it('falls back safely when persisted state names a removed theme', () => {
    expect(getTheme('system').id).toBe(DEFAULT_THEME_ID);
  });

  it('applies semantic CSS variables and synchronizes editor and terminal colors', () => {
    const root = document.createElement('div');
    const resolved = applyThemeToElement('deep-black', root);
    const editor = toPlatformTheme('deep-black');
    const terminal = toTerminalTheme('deep-black');

    expect(root.dataset.theme).toBe('deep-black');
    expect(root.style.getPropertyValue('--bg-editor')).toBe('#000000');
    expect(editor.colors['editor.background']).toBe('#000000');
    expect(terminal.background).toBe('#000000');
    expect(resolved.definition.artwork).toBe('prism');
  });

  it('blocks unresolved and circular semantic references', () => {
    const broken = structuredClone(THEMES[0]);
    broken.semanticTokens['broken'] = { ref: 'missing' };
    broken.semanticTokens['cycle-a'] = { ref: 'cycle-b' };
    broken.semanticTokens['cycle-b'] = { ref: 'cycle-a' };
    const engine = new ThemeEngine();
    const report = engine.load(broken);
    expect(report.valid).toBe(false);
    expect(report.errors.join(' ')).toContain('Unresolved reference');
    expect(report.errors.join(' ')).toContain('Circular reference');
  });
});
