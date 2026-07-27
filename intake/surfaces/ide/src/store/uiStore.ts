import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from '@/theme';
import { DEFAULT_FONT_ID, isFontId, type FontId } from '@/font';

export type SidePanel = 'explorer' | 'search' | 'git' | 'debug' | 'extensions';
export type ThemeMode = ThemeId;
export type PaletteMode = 'commands' | 'files';
export type DialogName = 'settings' | 'help' | null;
export type ToastKind = 'info' | 'success' | 'warning' | 'error';

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
  preferences: EditorPreferences;
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
  updatePreferences: (patch: Partial<EditorPreferences>) => void;
  resetPreferences: () => void;
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

export const useUIStore = create<UIState>()(persist((set) => ({
  activePanel: 'explorer',
  terminalVisible: false,
  aiChatVisible: false,
  paletteMode: null,
  dialog: null,
  sidePanelWidth: 272,
  terminalHeight: 240,
  aiPanelWidth: 470,
  preferences: DEFAULT_PREFERENCES,
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
  updatePreferences: (patch) => set((state) => ({
    preferences: { ...state.preferences, ...patch },
  })),
  resetPreferences: () => set({ preferences: DEFAULT_PREFERENCES }),
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
  version: 4,
  migrate: (persistedState) => {
    const state = persistedState as Partial<UIState>;
    const preferences = state.preferences as Partial<EditorPreferences> | undefined;
    return {
      ...state,
      preferences: {
        ...DEFAULT_PREFERENCES,
        ...preferences,
        theme: isThemeId(preferences?.theme) ? preferences.theme : DEFAULT_THEME_ID,
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
    preferences: state.preferences,
  }),
}));
