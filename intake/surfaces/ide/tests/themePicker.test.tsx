import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SettingsDialog } from '@/components/SettingsDialog';
import { ThemeArtwork } from '@/components/ThemeArtwork';
import { DEFAULT_PREFERENCES, useUIStore } from '@/store/uiStore';
import { FONT_OPTIONS } from '@/font';
import { applyThemeToElement, THEMES } from '@/theme';

describe('visual theme picker', () => {
  beforeEach(() => {
    localStorage.clear();
    useUIStore.setState({ preferences: DEFAULT_PREFERENCES, customThemes: {}, dialog: 'settings' });
  });

  it('shows all presets as visual radios and switches to Deep Black', () => {
    render(<SettingsDialog />);
    expect(screen.getAllByRole('radio')).toHaveLength(26);
    const deepBlack = screen.getByRole('radio', { name: /Deep Black/ });
    fireEvent.click(deepBlack);
    expect(useUIStore.getState().preferences.theme).toBe('deep-black');
    expect(deepBlack).toHaveAttribute('aria-checked', 'true');
  });

  it('restores Tokyo Night as the default', () => {
    useUIStore.getState().updatePreferences({ theme: 'claude', fontFamily: 'arial' });
    render(<SettingsDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore defaults' }));
    expect(useUIStore.getState().preferences.theme).toBe('tokyo-night');
    expect(useUIStore.getState().preferences.fontFamily).toBe('phantasy-mono-pty');
  });

  it('offers Phantasy by default plus eight terminal and two standard fonts', () => {
    render(<SettingsDialog />);
    const picker = screen.getByRole('combobox', { name: 'Workbench font' });
    expect(picker).toHaveValue('phantasy-mono-pty');
    expect(FONT_OPTIONS).toHaveLength(11);
    expect(FONT_OPTIONS.filter((font) => font.group === 'Classic terminal')).toHaveLength(8);
    expect(FONT_OPTIONS.filter((font) => font.group === 'Standard')).toHaveLength(2);
    fireEvent.change(picker, { target: { value: 'jetbrains-mono' } });
    expect(useUIStore.getState().preferences.fontFamily).toBe('jetbrains-mono');
  });

  it('renders the Deep Black prism inline without an image URL', () => {
    useUIStore.getState().updatePreferences({ theme: 'deep-black' });
    const { container } = render(<ThemeArtwork basePath="/wrong/base/path" className="welcome-mark" />);
    expect(container.querySelector('svg[data-theme-artwork="prism"]')).toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(container.querySelectorAll('svg path')).toHaveLength(8);
    applyThemeToElement('deep-black', document.documentElement);
    expect(document.documentElement.style.getPropertyValue('--on-accent')).toBe('#09090b');
  });

  it('uses the official CURSEM logo for every theme except Deep Black', () => {
    expect(THEMES.filter((theme) => theme.id !== 'deep-black').every((theme) => theme.artwork === 'official')).toBe(true);
    const { container } = render(<ThemeArtwork basePath="/ide" className="welcome-mark" />);
    const logo = container.querySelector('img[data-theme-artwork="official"]');
    expect(logo).toHaveAttribute('src', '/ide/brand/cursem-official.png');
    expect(container.querySelector('svg[data-theme-artwork="cursem"]')).not.toBeInTheDocument();
  });

  it('migrates obsolete theme modes without resetting other preferences', async () => {
    localStorage.setItem('cursem:ui:v2', JSON.stringify({
      version: 0,
      state: {
        sidePanelWidth: 333,
        preferences: { ...DEFAULT_PREFERENCES, theme: 'system', fontSize: 19 },
      },
    }));

    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState().preferences.theme).toBe('tokyo-night');
    expect(useUIStore.getState().preferences.fontFamily).toBe('phantasy-mono-pty');
    expect(useUIStore.getState().preferences.fontSize).toBe(19);
    expect(useUIStore.getState().sidePanelWidth).toBe(333);
  });
});
