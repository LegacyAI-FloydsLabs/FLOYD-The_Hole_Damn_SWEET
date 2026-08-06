// === Tests: src/platform/surfaceRegistry.ts (unified surface registry) =====
import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorStore } from '@/store/editorStore';
import {
  listSurfaces,
  registerTerminalSurfaceProvider,
  resolveSurface,
  type TerminalSurfaceProvider,
} from '@/platform/surfaceRegistry';

function providerFixture(): TerminalSurfaceProvider & { closed: string[]; renamed: Array<[string, string]> } {
  const provider = {
    closed: [] as string[],
    renamed: [] as Array<[string, string]>,
    list: () => [
      { id: 'term-aaaa1111', title: 'terminal 1' },
      { id: 'term-bbbb2222', title: 'terminal 2' },
    ],
    activeId: () => 'term-aaaa1111',
    focus: () => {},
    close: (id: string) => { provider.closed.push(id); },
    rename: (id: string, title: string) => { provider.renamed.push([id, title]); },
    sendInput: () => {},
    readScreen: () => null,
  };
  return provider;
}

beforeEach(() => {
  useEditorStore.getState().closeAllTabs();
  useEditorStore.getState().resetForWorkspace();
  registerTerminalSurfaceProvider(providerFixture());
});

describe('surfaceRegistry', () => {
  it('unifies editor tabs and terminal sessions with stable ids', () => {
    useEditorStore.getState().openTab('/ws/src/a.ts');
    useEditorStore.getState().openTab('/ws/src/b.ts');
    const surfaces = listSurfaces();
    expect(surfaces.map((surface) => surface.id)).toEqual([
      'editor:/ws/src/a.ts',
      'editor:/ws/src/b.ts',
      'terminal:term-aaaa1111',
      'terminal:term-bbbb2222',
    ]);
    expect(surfaces[1].focused).toBe(true); // b.ts is the active editor tab
    expect(surfaces[2].focused).toBe(true); // term-aaaa1111 is the active terminal
    expect(surfaces[2].sessionId).toBe('term-aaaa1111');
  });

  it('resolves full ids and unique prefixes, typed when asked', () => {
    useEditorStore.getState().openTab('/ws/src/a.ts');
    expect(resolveSurface('editor:/ws/src/a.ts')).toMatchObject({ ok: true });
    expect(resolveSurface('terminal:term-bbbb')).toMatchObject({ ok: true });
    const typed = resolveSurface('terminal:term-aaaa', 'terminal');
    expect(typed).toMatchObject({ ok: true });
    // Same prefix fails when restricted to editors.
    expect(resolveSurface('terminal:term-aaaa', 'editor')).toMatchObject({ ok: false, code: 'no-such' });
  });

  it('fails deterministically on no-such and ambiguous prefixes', () => {
    expect(resolveSurface('terminal:nope')).toMatchObject({ ok: false, code: 'no-such' });
    registerTerminalSurfaceProvider({
      ...providerFixture(),
      list: () => [
        { id: 'term-aaaa1111', title: 'a' },
        { id: 'term-aaaa9999', title: 'b' },
      ],
    });
    expect(resolveSurface('terminal:term-aaaa')).toMatchObject({ ok: false, code: 'ambiguous' });
  });
});
