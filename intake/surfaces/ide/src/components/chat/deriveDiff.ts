// ─── Patch → diff derivation (Phase 4 S4) ───────────────────────────────
//
// Maps a typed <cursem-patch> change set to {path, before, after} triples the
// DiffView can render. "before" is supplied by the caller (fetched through
// the host fs read gateway or from a checkpoint) so derivation itself stays
// pure and testable.

import type { AgentPatchChange } from '@/platform';

export interface DerivedDiff {
  path: string;
  before: string;
  after: string;
  operation: 'create' | 'modify' | 'delete';
}

/**
 * Derive renderable diffs from patch changes. beforeByPath maps each path to
 * its current on-disk content, or null/undefined when the file does not yet
 * exist (a create). content:null changes are deletes.
 */
export function deriveDiffs(changes: AgentPatchChange[], beforeByPath: Record<string, string | null | undefined>): DerivedDiff[] {
  return changes.map((change) => {
    const before = beforeByPath[change.path];
    if (change.content === null) {
      return { path: change.path, before: before ?? '', after: '', operation: 'delete' };
    }
    if (before === null || before === undefined) {
      return { path: change.path, before: '', after: change.content, operation: 'create' };
    }
    return { path: change.path, before, after: change.content, operation: 'modify' };
  });
}
