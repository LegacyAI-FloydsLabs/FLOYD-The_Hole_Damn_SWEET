import { create } from 'zustand';
import type { Tab } from '@/editor';
import { getDocumentType } from '@/editor/fileRouting';

export interface CursorPosition {
  line: number;
  column: number;
}

/** Build a tab routed by extension: document files open as viewer tabs. */
function makeTab(path: string, preview: boolean): Tab {
  const documentType = getDocumentType(path);
  return documentType
    ? { path, isDirty: false, isPreview: preview, kind: 'document', documentType }
    : { path, isDirty: false, isPreview: preview };
}

interface EditorState {
  tabs: Tab[];
  activeTabPath: string | null;
  recentlyClosed: string[];
  cursor: CursorPosition;
  /** Per-path markdown preview flags (survive tab reuse, like Cate's panel flag). */
  markdownPreview: Record<string, boolean>;

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
  toggleMarkdownPreview: (path: string) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTabPath: null,
  recentlyClosed: [],
  cursor: { line: 1, column: 1 },
  markdownPreview: {},

  openTab: (path, preview = false) => set((state) => {
    const existing = state.tabs.find((tab) => tab.path === path);
    if (existing) return { activeTabPath: path };
    return { tabs: [...state.tabs, makeTab(path, preview)], activeTabPath: path };
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
      tabs: [...state.tabs, makeTab(path, false)],
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
  toggleMarkdownPreview: (path) => set((state) => ({
    markdownPreview: { ...state.markdownPreview, [path]: !state.markdownPreview[path] },
  })),
}));
