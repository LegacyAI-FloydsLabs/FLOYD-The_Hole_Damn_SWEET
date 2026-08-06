import { useEffect, useRef, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Icon } from './Icon';
import { DEFAULT_PREFERENCES, useUIStore, type ThemeMode } from '@/store/uiStore';
import { definitionToUnified, parseThemeImport, resolveTheme, THEMES, unifiedToDefinition, validateTheme } from '@/theme';
import { FONT_OPTIONS, fontStack, type FontId } from '@/font';
import type { ThemeDefinition } from '@/theme';

const themeGroups = [...new Set(THEMES.map((theme) => theme.group))];
const fontGroups = [...new Set(FONT_OPTIONS.map((font) => font.group))];

/** Valid imported themes as resolvable definitions (invalid persisted entries
 *  are hidden from the gallery but never deleted from storage). */
function customDefinitions(customThemes: Record<string, unknown>): ThemeDefinition[] {
  const definitions: ThemeDefinition[] = [];
  for (const raw of Object.values(customThemes)) {
    const result = validateTheme(raw);
    if (result.ok) definitions.push(unifiedToDefinition(result.theme));
  }
  return definitions;
}

export function SettingsDialog() {
  const preferences = useUIStore((state) => state.preferences);
  const customThemes = useUIStore((state) => state.customThemes);
  const updatePreferences = useUIStore((state) => state.updatePreferences);
  const setCustomThemes = useUIStore((state) => state.setCustomThemes);
  const resetPreferences = useUIStore((state) => state.resetPreferences);
  const addToast = useUIStore((state) => state.addToast);
  const closeDialog = useUIStore((state) => state.closeDialog);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const imported = customDefinitions(customThemes);

  useEffect(() => {
    headingRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDialog();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeDialog]);

  const importThemes = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const existingIds = new Set<string>([...THEMES.map((theme) => theme.id), ...Object.keys(customThemes)]);
    const { themes, errors } = parseThemeImport(await file.text(), existingIds);
    if (themes.length > 0) {
      const added = Object.fromEntries(themes.map((theme) => [theme.id, theme]));
      setCustomThemes({ ...customThemes, ...added });
      addToast(`Imported ${themes.length} theme${themes.length === 1 ? '' : 's'}: ${themes.map((theme) => theme.name).join(', ')}.`, 'success');
    }
    for (const error of errors) addToast(error, 'error');
    if (themes.length === 0 && errors.length === 0) addToast('No themes found in the selected file.', 'warning');
  };

  const exportTheme = (id: string) => {
    const document = definitionToUnified(resolveTheme(id));
    const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }));
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = `${id}.theme.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    addToast(`Exported ${anchor.download}.`, 'success');
  };

  const deleteTheme = (id: string) => {
    const next = { ...customThemes };
    delete next[id];
    setCustomThemes(next);
    // Reference cleanup: any setting pointing at the removed theme resets.
    if (preferences.theme === id) updatePreferences({ theme: DEFAULT_PREFERENCES.theme });
    addToast('Removed the imported theme.', 'info');
  };

  const renderCard = (theme: ThemeDefinition, custom: boolean) => {
    // Resolved semantic tokens (works uniformly for built-ins and imports —
    // imported palettes are keyed by token name, not by base-color name).
    const tokens = resolveTheme(theme.id).tokens;
    const terminal = theme.terminal;
    const selected = preferences.theme === theme.id;
    const activate = () => updatePreferences({ theme: theme.id as ThemeMode });
    const onKeyDown = (event: ReactKeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
    };
    return (
      <div className="theme-card-wrap" key={theme.id}>
        <button type="button" className={`theme-card ${selected ? 'selected' : ''}`} role="radio" aria-checked={selected} onClick={activate} onKeyDown={onKeyDown} title={theme.description}>
          <span className="theme-preview" style={{ background: tokens['bg.editor'], borderColor: tokens['border.strong'] }}>
            <span style={{ background: tokens['accent.primary'] }} />
            <span style={{ background: tokens['accent.companion'] }} />
            <span style={{ background: tokens['semantic.success'] }} />
            <span style={{ background: tokens['semantic.warning'] }} />
          </span>
          <span>
            <strong>{theme.name}</strong>
            <small>{theme.description}</small>
            {terminal && (
              <span className="theme-ansi" aria-hidden="true">
                {[terminal.red, terminal.green, terminal.yellow, terminal.blue, terminal.magenta, terminal.cyan].map((color, index) => (
                  <span key={index} style={{ background: color }} />
                ))}
              </span>
            )}
          </span>
        </button>
        <span className="theme-card-actions">
          <button type="button" className="icon-button compact" onClick={() => exportTheme(theme.id)} title={`Export ${theme.name}`} aria-label={`Export ${theme.name}`}><Icon name="download" size={13} /></button>
          {custom && <button type="button" className="icon-button compact" onClick={() => deleteTheme(theme.id)} title={`Delete ${theme.name}`} aria-label={`Delete ${theme.name}`}><Icon name="trash" size={13} /></button>}
        </span>
      </div>
    );
  };

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
              <span><strong id="theme-setting-title">Color theme</strong><small>Dark and light presets update the workbench, editor, terminal, and theme artwork together. Import a unified theme JSON to add your own.</small></span>
              <span className="theme-heading-side">
                <span className="theme-current">{resolveTheme(preferences.theme).definition.name}</span>
                <button type="button" className="button secondary compact-button" onClick={() => importRef.current?.click()}>Import…</button>
              </span>
            </div>
            <input ref={importRef} type="file" accept=".json,application/json" className="visually-hidden" aria-label="Import theme file" onChange={(event) => void importThemes(event)} />
            <div className="theme-gallery" role="radiogroup" aria-label="Color theme">
              {themeGroups.map((group) => (
                <div className="theme-group" key={group}>
                  <h3>{group}</h3>
                  <div className="theme-card-grid">
                    {THEMES.filter((theme) => theme.group === group).map((theme) => renderCard(theme, false))}
                  </div>
                </div>
              ))}
              {imported.length > 0 && (
                <div className="theme-group">
                  <h3>Imported</h3>
                  <div className="theme-card-grid">
                    {imported.map((theme) => renderCard(theme, true))}
                  </div>
                </div>
              )}
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
