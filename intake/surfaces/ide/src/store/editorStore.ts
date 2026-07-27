import { create } from 'zustand';
import type { Tab } from '@/editor';

export interface CursorPosition {
  line: number;
  column: number;
}

interface EditorState {
  tabs: Tab[];
  activeTabPath: string | null;
  recentlyClosed: string[];
  cursor: CursorPosition;

  openTab: (path: string, preview?: boolean) => void;
  closeTab: (path: string) => void;
  closeOtherTabs: (path: string) => void;
  closeAllTabs: () => void;
  resetForWorkspace: () => void;
  reopenClosedTab: () => void;
  reorderTab: (fromPath: string, toPath: string) => void;
  setActiveTab: (path: string) => void;
  markDirty: (path: string, dirty: boolean) => void;
  setCursor: (line: number, column: number) => void;
  getTab: (path: string) => Tab | undefined;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTabPath: null,
  recentlyClosed: [],
  cursor: { line: 1, column: 1 },

  openTab: (path, preview = false) => set((state) => {
    const existing = state.tabs.find((tab) => tab.path === path);
    if (existing) return { activeTabPath: path };
    const tab: Tab = { path, isDirty: false, isPreview: preview };
    return { tabs: [...state.tabs, tab], activeTabPath: path };
  }),

  closeTab: (path) => set((state) => {
    const index = state.tabs.findIndex((tab) => tab.path === path);
    if (index < 0) return state;
    const tabs = state.tabs.filter((tab) => tab.path !== path);
    const activeTabPath = state.activeTabPath === path
      ? (tabs[index]?.path ?? tabs[index - 1]?.path ?? null)
      : state.activeTabPath;
    return {
      tabs,
      activeTabPath,
      recentlyClosed: [path, ...state.recentlyClosed.filter((item) => item !== path)].slice(0, 10),
    };
  }),

  closeOtherTabs: (path) => set((state) => ({
    tabs: state.tabs.filter((tab) => tab.path === path),
    activeTabPath: path,
    recentlyClosed: [
      ...state.tabs.filter((tab) => tab.path !== path).map((tab) => tab.path),
      ...state.recentlyClosed,
    ].slice(0, 10),
  })),

  closeAllTabs: () => set((state) => ({
    tabs: [],
    activeTabPath: null,
    recentlyClosed: [...state.tabs.map((tab) => tab.path), ...state.recentlyClosed].slice(0, 10),
  })),

  resetForWorkspace: () => set({
    tabs: [],
    activeTabPath: null,
    recentlyClosed: [],
    cursor: { line: 1, column: 1 },
  }),

  reopenClosedTab: () => set((state) => {
    const [path, ...recentlyClosed] = state.recentlyClosed;
    if (!path) return state;
    if (state.tabs.some((tab) => tab.path === path)) return { recentlyClosed, activeTabPath: path };
    return {
      tabs: [...state.tabs, { path, isDirty: false, isPreview: false }],
      activeTabPath: path,
      recentlyClosed,
    };
  }),

  reorderTab: (fromPath, toPath) => set((state) => {
    const from = state.tabs.findIndex((tab) => tab.path === fromPath);
    const to = state.tabs.findIndex((tab) => tab.path === toPath);
    if (from < 0 || to < 0 || from === to) return state;
    const tabs = [...state.tabs];
    const [moved] = tabs.splice(from, 1);
    tabs.splice(to, 0, moved);
    return { tabs };
  }),

  setActiveTab: (path) => set({ activeTabPath: path }),
  markDirty: (path, dirty) => set((state) => ({
    tabs: state.tabs.map((tab) => tab.path === path ? { ...tab, isDirty: dirty } : tab),
  })),
  setCursor: (line, column) => set({ cursor: { line, column } }),
  getTab: (path) => get().tabs.find((tab) => tab.path === path),
}));
