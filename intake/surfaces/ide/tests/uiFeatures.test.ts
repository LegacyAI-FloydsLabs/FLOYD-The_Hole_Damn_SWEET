import { beforeEach, describe, expect, it } from 'vitest';
import { FEATURE_MANIFEST } from '@/features/featureManifest';
import { DEFAULT_PREFERENCES, useUIStore } from '@/store/uiStore';

describe('first autonomous feature batch', () => {
  beforeEach(() => {
    localStorage.clear();
    useUIStore.setState({
      activePanel: 'explorer', sidePanelWidth: 272, terminalHeight: 240, aiPanelWidth: 470,
      preferences: DEFAULT_PREFERENCES, toasts: [], paletteMode: null, dialog: null,
    });
  });

  it('contains exactly twenty concrete product features', () => {
    expect(FEATURE_MANIFEST).toHaveLength(20);
    expect(new Set(FEATURE_MANIFEST).size).toBe(20);
  });

  it('clamps resizable panes and updates backed-up editor preferences', () => {
    const store = useUIStore.getState();
    store.setSidePanelWidth(900);
    store.setTerminalHeight(20);
    store.setAIPanelWidth(10);
    store.updatePreferences({ fontSize: 16, autoSaveDelay: 750 });
    const state = useUIStore.getState();
    expect(state.sidePanelWidth).toBe(480);
    expect(state.terminalHeight).toBe(130);
    expect(state.aiPanelWidth).toBe(360);
    expect(state.preferences).toMatchObject({ fontSize: 16, autoSaveDelay: 750 });
  });

  it('queues and dismisses status notifications', () => {
    const id = useUIStore.getState().addToast('Saved file.', 'success');
    expect(useUIStore.getState().toasts).toEqual([expect.objectContaining({ id, kind: 'success' })]);
    useUIStore.getState().removeToast(id);
    expect(useUIStore.getState().toasts).toHaveLength(0);
  });

  it('preserves imported custom theme ids and customThemes through persistence migration', async () => {
    localStorage.setItem('cursem:ui:v2', JSON.stringify({
      state: {
        preferences: { ...DEFAULT_PREFERENCES, theme: 'olive-custom' },
        customThemes: { 'olive-custom': { name: 'Olive Custom' } },
      },
      version: 3,
    }));
    await useUIStore.persist.rehydrate();
    const state = useUIStore.getState() as ReturnType<typeof useUIStore.getState> & { customThemes?: Record<string, unknown> };
    expect(state.preferences.theme).toBe('olive-custom');
    expect(state.customThemes).toMatchObject({ 'olive-custom': { name: 'Olive Custom' } });
  });

  it('still resets genuinely malformed persisted theme ids to the default', async () => {
    localStorage.setItem('cursem:ui:v2', JSON.stringify({
      state: { preferences: { ...DEFAULT_PREFERENCES, theme: 42 } },
      version: 3,
    }));
    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState().preferences.theme).toBe(DEFAULT_PREFERENCES.theme);
  });
});
