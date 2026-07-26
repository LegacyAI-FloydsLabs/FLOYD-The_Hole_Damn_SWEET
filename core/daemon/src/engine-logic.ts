/**
 * Pure decision logic for the OpenCode seam — kept side-effect-free so the
 * idle/recovery contract is unit-testable (live 1.17.15 returns messages
 * NEWEST FIRST; these helpers are order-agnostic by design).
 */

export type EngineMessage = Record<string, unknown>;

function createdOf(m: EngineMessage): number {
  return Number(((m.time ?? {}) as Record<string, unknown>).created ?? 0);
}

export function newestMessage(msgs: EngineMessage[]): EngineMessage | null {
  if (!Array.isArray(msgs) || msgs.length === 0) return null;
  return msgs.reduce((a, b) => (createdOf(b) > createdOf(a) ? b : a));
}

/** Terminal = a completed assistant turn that is not a mid-work tool-calls turn. */
export function isTerminalAssistant(m: EngineMessage | null): boolean {
  if (!m || m.type !== "assistant") return false;
  const time = (m.time ?? {}) as Record<string, unknown>;
  if (!time.completed) return false;
  return m.finish !== "tool-calls";
}

/** True when any assistant turn exists — recovery must then observe, never re-prompt. */
export function containsAssistantTurn(msgs: EngineMessage[]): boolean {
  return Array.isArray(msgs) && msgs.some((m) => m.type === "assistant");
}

/**
 * True when the newest message is a completed tool-calls assistant turn: the
 * engine died mid tool loop and the session will never self-complete. Recovery
 * may send a continuation prompt (work products persist in the worktree; no
 * external side effect is duplicated).
 */
export function isStalledToolCalls(msgs: EngineMessage[]): boolean {
  const last = newestMessage(msgs);
  if (!last || last.type !== "assistant") return false;
  const time = (last.time ?? {}) as Record<string, unknown>;
  return Boolean(time.completed) && last.finish === "tool-calls";
}
