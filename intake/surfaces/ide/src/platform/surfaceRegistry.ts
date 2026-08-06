// CURSE'M IDE — unified surface registry (in-shell CLI control surface).
//
// One enumeration over every addressable IDE surface — editor tabs and
// terminal sessions — replacing Cate's windowPanels union. Both the control
// executor (src/platform/controlExecutor.ts) and future consumers share this
// module. Terminal data flows in through a provider registered by
// TerminalPane at module load, so this registry never statically imports the
// lazily-loaded terminal layer.

import { useEditorStore } from '@/store/editorStore';

export interface SurfaceDescriptor {
  /** Stable address: `editor:<absolute path>` or `terminal:<sessionId>`. */
  id: string;
  type: 'editor' | 'terminal';
  title: string;
  focused: boolean;
  /** Editor surfaces only. */
  path?: string;
  /** Terminal surfaces only. */
  sessionId?: string;
}

/** The terminal layer's live capabilities, supplied by TerminalPane. All
 *  reads/writes go through the TerminalOneAdapter — the same code path user
 *  keystrokes take. */
export interface TerminalSurfaceProvider {
  list(): Array<{ id: string; title: string }>;
  activeId(): string | null;
  focus(sessionId: string): void;
  close(sessionId: string): void;
  rename(sessionId: string, title: string): void;
  sendInput(sessionId: string, data: string): void;
  /** Rendered screen text (scrollback + viewport) or null when unknown. */
  readScreen(sessionId: string): string | null;
}

let terminalProvider: TerminalSurfaceProvider | null = null;

export function registerTerminalSurfaceProvider(provider: TerminalSurfaceProvider): void {
  terminalProvider = provider;
}

export function getTerminalSurfaceProvider(): TerminalSurfaceProvider | null {
  return terminalProvider;
}

/** Enumerate every surface: editor tabs first, then terminal sessions. */
export function listSurfaces(): SurfaceDescriptor[] {
  const editor = useEditorStore.getState();
  const surfaces: SurfaceDescriptor[] = editor.tabs.map((tab) => ({
    id: `editor:${tab.path}`,
    type: 'editor',
    title: tab.path.split('/').pop() || tab.path,
    focused: editor.activeTabPath === tab.path,
    path: tab.path,
  }));
  if (terminalProvider) {
    const activeId = terminalProvider.activeId();
    for (const session of terminalProvider.list()) {
      surfaces.push({
        id: `terminal:${session.id}`,
        type: 'terminal',
        title: session.title,
        focused: session.id === activeId,
        sessionId: session.id,
      });
    }
  }
  return surfaces;
}

export type ResolvedSurface =
  | { ok: true; surface: SurfaceDescriptor }
  | { ok: false; code: 'no-such' | 'ambiguous'; message: string };

/**
 * Resolve a full surface id or unique prefix. The CLI resolves prefixes
 * client-side before invoking; the executor re-validates server-side so a
 * stale or forged id fails deterministically instead of hitting the wrong
 * surface.
 */
export function resolveSurface(idOrPrefix: string, type?: SurfaceDescriptor['type']): ResolvedSurface {
  const candidates = listSurfaces().filter((surface) => !type || surface.type === type);
  const exact = candidates.find((surface) => surface.id === idOrPrefix);
  if (exact) return { ok: true, surface: exact };
  const matches = candidates.filter((surface) => surface.id.startsWith(idOrPrefix));
  if (matches.length === 1) return { ok: true, surface: matches[0] };
  if (matches.length === 0) {
    return { ok: false, code: 'no-such', message: `No ${type ?? ''} surface matches "${idOrPrefix}".` };
  }
  return { ok: false, code: 'ambiguous', message: `"${idOrPrefix}" matches ${matches.length} surfaces.` };
}
