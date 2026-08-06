import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_THEME_ID, isThemeId, syncCustomThemes, type ThemeId, type UnifiedTheme } from '@/theme';
import { DEFAULT_FONT_ID, isFontId, type FontId } from '@/font';

export type SidePanel = 'explorer' | 'search' | 'git' | 'debug' | 'extensions';
export type ThemeMode = ThemeId;
export type PaletteMode = 'commands' | 'files';
export type DialogName = 'settings' | 'help' | null;
export type ToastKind = 'info' | 'success' | 'warning' | 'error';

/** Imported user themes keyed by id (unified theme documents). */
export type CustomThemeMap = Record<string, UnifiedTheme>;

export interface EditorPreferences {
  theme: ThemeMode;
  fontFamily: FontId;
  fontSize: number;
  lineHeight: number;
  wordWrap: boolean;
  minimap: boolean;
  autoSave: boolean;
  autoSaveDelay: number;
  formatOnSave: boolean;
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
  reducedMotion: boolean;
}

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}

interface UIState {
  activePanel: SidePanel | null;
  terminalVisible: boolean;
  aiChatVisible: boolean;
  paletteMode: PaletteMode | null;
  dialog: DialogName;
  sidePanelWidth: number;
  terminalHeight: number;
  aiPanelWidth: number;
  aiProviderId: string | null;
  aiModel: string | null;
  preferences: EditorPreferences;
  customThemes: CustomThemeMap;
  toasts: Toast[];

  setPanel: (panel: SidePanel | null) => void;
  togglePanel: (panel: SidePanel) => void;
  toggleTerminal: () => void;
  toggleAIChat: () => void;
  openPalette: (mode: PaletteMode) => void;
  closePalette: () => void;
  openDialog: (dialog: Exclude<DialogName, null>) => void;
  closeDialog: () => void;
  setSidePanelWidth: (width: number) => void;
  setTerminalHeight: (height: number) => void;
  setAIPanelWidth: (width: number) => void;
  setAIModelSelection: (providerId: string, model: string) => void;
  updatePreferences: (patch: Partial<EditorPreferences>) => void;
  resetPreferences: () => void;
  setCustomThemes: (themes: CustomThemeMap) => void;
  addToast: (message: string, kind?: ToastKind) => string;
  removeToast: (id: string) => void;
}

export const DEFAULT_PREFERENCES: EditorPreferences = {
  theme: DEFAULT_THEME_ID,
  fontFamily: DEFAULT_FONT_ID,
  fontSize: 14,
  lineHeight: 22,
  wordWrap: true,
  minimap: true,
  autoSave: true,
  autoSaveDelay: 1000,
  formatOnSave: true,
  trimTrailingWhitespace: true,
  insertFinalNewline: true,
  reducedMotion: false,
};

let toastSequence = 0;

// Imported user themes carry ids outside the static preset list. Any id that
// is at least a well-formed token must survive persistence migration — the
// theme registry falls back to the default until the custom theme registers.
// Legacy builds persisted theme *modes* instead of preset ids; those still
// reset to the default rather than being mistaken for imported themes.
const OBSOLETE_THEME_MODES = new Set(['system', 'light', 'dark']);

function isWellFormedThemeId(value: unknown): value is string {
  return typeof value === 'string'
    && !OBSOLETE_THEME_MODES.has(value)
    && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

export const useUIStore = create<UIState>()(persist((set) => ({
  activePanel: 'explorer',
  terminalVisible: false,
  aiChatVisible: false,
  paletteMode: null,
  dialog: null,
  sidePanelWidth: 272,
  terminalHeight: 240,
  aiPanelWidth: 470,
  aiProviderId: null,
  aiModel: null,
  preferences: DEFAULT_PREFERENCES,
  customThemes: {},
  toasts: [],

  setPanel: (panel) => set({ activePanel: panel }),
  togglePanel: (panel) => set((state) => ({
    activePanel: state.activePanel === panel ? null : panel,
  })),
  toggleTerminal: () => set((state) => ({ terminalVisible: !state.terminalVisible })),
  toggleAIChat: () => set((state) => ({ aiChatVisible: !state.aiChatVisible })),
  openPalette: (paletteMode) => set({ paletteMode }),
  closePalette: () => set({ paletteMode: null }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
  setSidePanelWidth: (width) => set({ sidePanelWidth: Math.max(210, Math.min(480, width)) }),
  setTerminalHeight: (height) => set({ terminalHeight: Math.max(130, Math.min(560, height)) }),
  setAIPanelWidth: (width) => set({ aiPanelWidth: Math.max(360, Math.min(760, width)) }),
  setAIModelSelection: (providerId, model) => set({ aiProviderId: providerId, aiModel: model }),
  updatePreferences: (patch) => set((state) => ({
    preferences: { ...state.preferences, ...patch },
  })),
  resetPreferences: () => set({ preferences: DEFAULT_PREFERENCES }),
  setCustomThemes: (customThemes) => {
    syncCustomThemes(Object.values(customThemes));
    set({ customThemes });
  },
  addToast: (message, kind = 'info') => {
    const id = `toast-${Date.now()}-${toastSequence++}`;
    set((state) => ({ toasts: [...state.toasts.slice(-3), { id, kind, message }] }));
    return id;
  },
  removeToast: (id) => set((state) => ({
    toasts: state.toasts.filter((toast) => toast.id !== id),
  })),
}), {
  name: 'cursem:ui:v2',
  version: 5,
  migrate: (persistedState) => {
    const state = persistedState as Partial<UIState>;
    const preferences = state.preferences as Partial<EditorPreferences> | undefined;
    // `...state` already carries any customThemes map forward; the theme id
    // guard below keeps unknown-but-well-formed ids (imported user themes)
    // instead of deleting them, and only resets genuinely malformed values.
    // Persisted customThemes are preserved verbatim (even pre-unified entries)
    // and validated at registration time by syncCustomThemes instead.
    const theme = preferences?.theme;
    return {
      ...state,
      customThemes:
        state.customThemes && typeof state.customThemes === 'object' && !Array.isArray(state.customThemes)
          ? state.customThemes
          : {},
      preferences: {
        ...DEFAULT_PREFERENCES,
        ...preferences,
        theme: isThemeId(theme) || isWellFormedThemeId(theme) ? (theme as ThemeId) : DEFAULT_THEME_ID,
        fontFamily: isFontId(preferences?.fontFamily) ? preferences.fontFamily : DEFAULT_FONT_ID,
      },
    } as UIState;
  },
  partialize: (state) => ({
    activePanel: state.activePanel,
    terminalVisible: state.terminalVisible,
    aiChatVisible: state.aiChatVisible,
    sidePanelWidth: state.sidePanelWidth,
    terminalHeight: state.terminalHeight,
    aiPanelWidth: state.aiPanelWidth,
    aiProviderId: state.aiProviderId,
    aiModel: state.aiModel,
    preferences: state.preferences,
    customThemes: state.customThemes,
  }),
  onRehydrateStorage: () => (state) => {
    // Re-register imported themes with the resolver after storage loads.
    if (state) syncCustomThemes(Object.values(state.customThemes));
  },
}));
