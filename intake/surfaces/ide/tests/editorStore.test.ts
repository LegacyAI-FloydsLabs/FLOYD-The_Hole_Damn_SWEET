import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorStore } from '@/store/editorStore';

describe('editorStore', () => {
  beforeEach(() => useEditorStore.setState({ tabs: [], activeTabPath: null, recentlyClosed: [], cursor: { line: 1, column: 1 } }));

  it('opens, reorders, closes, and reopens tabs without duplicating them', () => {
    const store = useEditorStore.getState();
    store.openTab('/workspace/a.ts');
    store.openTab('/workspace/b.ts');
    store.openTab('/workspace/a.ts');
    expect(useEditorStore.getState().tabs.map((tab) => tab.path)).toEqual(['/workspace/a.ts', '/workspace/b.ts']);

    useEditorStore.getState().reorderTab('/workspace/b.ts', '/workspace/a.ts');
    expect(useEditorStore.getState().tabs.map((tab) => tab.path)).toEqual(['/workspace/b.ts', '/workspace/a.ts']);

    useEditorStore.getState().closeTab('/workspace/a.ts');
    expect(useEditorStore.getState().activeTabPath).toBe('/workspace/b.ts');
    useEditorStore.getState().reopenClosedTab();
    expect(useEditorStore.getState().activeTabPath).toBe('/workspace/a.ts');
  });

  it('tracks dirty state and cursor position', () => {
    useEditorStore.getState().openTab('/workspace/a.ts');
    useEditorStore.getState().markDirty('/workspace/a.ts', true);
    useEditorStore.getState().setCursor(12, 8);
    expect(useEditorStore.getState().tabs[0].isDirty).toBe(true);
    expect(useEditorStore.getState().cursor).toEqual({ line: 12, column: 8 });
  });
});
