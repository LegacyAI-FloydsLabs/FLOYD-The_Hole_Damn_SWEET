/**
 * Never-silent completion guard for the /api/chat/stream provider loops.
 *
 * Two failure modes used to leave the chat UI totally blank:
 *  - the agent spent every token on tool calls (or exhausted maxTurns
 *    mid-work) and produced no assistant text, so nothing was streamed,
 *    saved, or rendered;
 *  - the provider cut the response off at the Max Tokens limit
 *    (finish_reason 'length' / stop_reason 'max_tokens') with no signal
 *    to the user.
 * These helpers build the fallback completion message and the truncation
 * note the stream route appends in those cases.
 */

/** Markdown note appended to a truncated assistant response. */
export const TRUNCATION_NOTE =
  '\n\n*Response hit the Max Tokens limit — raise it in Settings or say "continue".*';

/** "list_directory, read_file ×3, execute_command" (insertion order kept). */
export function summarizeToolActions(toolNames: string[]): string {
  const counts = new Map<string, number>();
  for (const name of toolNames) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(', ');
}

/**
 * One-two sentence completion message used when a run ends with no written
 * assistant text, so the turn is never silent.
 */
export function buildNeverSilentCompletion(toolNames: string[]): string {
  if (toolNames.length === 0) {
    return 'Done — I finished the run but produced no written summary. Ask me to summarize what I found.';
  }
  const noun = toolNames.length === 1 ? 'tool action' : 'tool actions';
  return `Done — I ran ${toolNames.length} ${noun} (${summarizeToolActions(toolNames)}) but produced no written summary. Ask me to summarize what I found.`;
}
