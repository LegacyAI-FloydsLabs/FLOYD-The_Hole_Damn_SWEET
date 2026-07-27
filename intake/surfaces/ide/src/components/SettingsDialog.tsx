import { useEffect, useRef } from 'react';
import { Icon } from './Icon';
import { useUIStore, type ThemeMode } from '@/store/uiStore';
import { resolveTheme, THEMES } from '@/theme';
import { FONT_OPTIONS, fontStack, type FontId } from '@/font';

const themeGroups = [...new Set(THEMES.map((theme) => theme.group))];
const fontGroups = [...new Set(FONT_OPTIONS.map((font) => font.group))];

export function SettingsDialog() {
  const preferences = useUIStore((state) => state.preferences);
  const updatePreferences = useUIStore((state) => state.updatePreferences);
  const resetPreferences = useUIStore((state) => state.resetPreferences);
  const closeDialog = useUIStore((state) => state.closeDialog);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDialog();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeDialog]);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeDialog()}>
      <section className="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="dialog-header">
          <div>
            <p className="eyebrow">Workbench</p>
            <h2 id="settings-title" ref={headingRef} tabIndex={-1}>Settings</h2>
          </div>
          <button className="icon-button" onClick={closeDialog} aria-label="Close settings"><Icon name="close" /></button>
        </header>
        <div className="settings-grid">
          <label className="setting-row font-setting-row">
            <span><strong>Workbench font</strong><small>Phantasy is bundled; eight terminal classics and two standard faces use installed macOS fonts.</small></span>
            <select aria-label="Workbench font" value={preferences.fontFamily} style={{ fontFamily: fontStack(preferences.fontFamily) }} onChange={(event) => updatePreferences({ fontFamily: event.target.value as FontId })}>
              {fontGroups.map((group) => (
                <optgroup key={group} label={group}>
                  {FONT_OPTIONS.filter((font) => font.group === group).map((font) => (
                    <option key={font.id} value={font.id} title={font.description}>{font.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <section className="theme-setting" aria-labelledby="theme-setting-title">
            <div className="theme-setting-heading">
              <span><strong id="theme-setting-title">Color theme</strong><small>Sixteen dark presets update the workbench, editor, terminal, and theme artwork together.</small></span>
              <span className="theme-current">{resolveTheme(preferences.theme).definition.name}</span>
            </div>
            <div className="theme-gallery" role="radiogroup" aria-label="Color theme">
              {themeGroups.map((group) => (
                <div className="theme-group" key={group}>
                  <h3>{group}</h3>
                  <div className="theme-card-grid">
                    {THEMES.filter((theme) => theme.group === group).map((theme) => {
                      const palette = theme.palette;
                      return (
                        <button type="button" key={theme.id} className={`theme-card ${preferences.theme === theme.id ? 'selected' : ''}`} role="radio" aria-checked={preferences.theme === theme.id} onClick={() => updatePreferences({ theme: theme.id as ThemeMode })} title={theme.description}>
                          <span className="theme-preview" style={{ background: palette.editor, borderColor: palette.borderStrong }}>
                            <span style={{ background: palette.accent }} />
                            <span style={{ background: palette.companion }} />
                            <span style={{ background: palette.success }} />
                            <span style={{ background: palette.warning }} />
                          </span>
                          <span><strong>{theme.name}</strong><small>{theme.description}</small></span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>
          <label className="setting-row">
            <span><strong>Editor font size</strong><small>Applied live to Monaco; the selected family also applies to TerminalOne.</small></span>
            <input type="number" min="11" max="24" value={preferences.fontSize} onChange={(event) => updatePreferences({ fontSize: Number(event.target.value) })} />
          </label>
          <label className="setting-row">
            <span><strong>Editor line height</strong><small>22px corresponds to the backed-up 1.6 setting.</small></span>
            <input type="number" min="16" max="36" value={preferences.lineHeight} onChange={(event) => updatePreferences({ lineHeight: Number(event.target.value) })} />
          </label>
          <label className="setting-row">
            <span><strong>Autosave delay</strong><small>Write dirty buffers to the real workspace after inactivity.</small></span>
            <input type="number" min="250" max="10000" step="250" value={preferences.autoSaveDelay} disabled={!preferences.autoSave} onChange={(event) => updatePreferences({ autoSaveDelay: Number(event.target.value) })} />
          </label>
          {([
            ['autoSave', 'Autosave', 'Enabled in the customization backup.'],
            ['formatOnSave', 'Format on save', 'Run the language formatter before writing.'],
            ['trimTrailingWhitespace', 'Trim trailing whitespace', 'Keep files clean on save.'],
            ['insertFinalNewline', 'Insert final newline', 'Keep text files POSIX-friendly.'],
            ['wordWrap', 'Word wrap', 'Wrap long lines in the editor.'],
            ['minimap', 'Minimap', 'Show code overview on the editor edge.'],
            ['reducedMotion', 'Reduce motion', 'Disable nonessential transitions.'],
          ] as const).map(([key, label, help]) => (
            <label className="setting-row toggle-row" key={key}>
              <span><strong>{label}</strong><small>{help}</small></span>
              <input type="checkbox" checked={preferences[key]} onChange={(event) => updatePreferences({ [key]: event.target.checked })} />
            </label>
          ))}
        </div>
        <footer className="dialog-footer">
          <button className="button secondary" onClick={() => resetPreferences()}>Restore defaults</button>
          <button className="button primary" onClick={closeDialog}>Apply</button>
        </footer>
      </section>
    </div>
  );
}
