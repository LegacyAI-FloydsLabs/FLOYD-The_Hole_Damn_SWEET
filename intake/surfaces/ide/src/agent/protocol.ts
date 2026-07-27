import type { AgentPatchChange, ContextSelector } from '@/platform';

const MAX_PATCH_FILES = 128;

export interface ParsedAgentPatch {
  changes: AgentPatchChange[];
  explanation: string;
}

export type AgentToolName = 'search' | 'read_file' | 'list_dir' | 'git_diff' | 'run_task' | 'rules' | 'mcp';
export interface AgentToolCall { id: string; name: AgentToolName; arguments: Record<string, unknown> }

const TOOL_NAMES = new Set<AgentToolName>(['search', 'read_file', 'list_dir', 'git_diff', 'run_task', 'rules', 'mcp']);

export function parseAgentToolCall(text: string): AgentToolCall | null {
  const match = text.match(/<cursem-tool>([\s\S]*?)<\/cursem-tool>/i);
  if (!match) return parseLegacyToolCall(text);
  let payload: unknown;
  try { payload = JSON.parse(match[1].trim()); }
  catch { throw new Error('The provider returned invalid JSON inside <cursem-tool>.'); }
  if (!payload || typeof payload !== 'object') throw new Error('The tool envelope must contain an object.');
  const value = payload as { id?: unknown; name?: unknown; arguments?: unknown };
  if (typeof value.id !== 'string' || !value.id.trim()) throw new Error('The tool call requires an id.');
  if (typeof value.name !== 'string' || !TOOL_NAMES.has(value.name as AgentToolName)) throw new Error(`Unsupported Agent tool: ${String(value.name)}`);
  if (!value.arguments || typeof value.arguments !== 'object' || Array.isArray(value.arguments)) throw new Error('Tool arguments must be an object.');
  return { id: value.id, name: value.name as AgentToolName, arguments: value.arguments as Record<string, unknown> };
}

function parseLegacyToolCall(text: string): AgentToolCall | null {
  const match = text.match(/^\s*<function(?:\s+name=["']([^"']+)["'])?\s*>\s*<arguments>([\s\S]*?)<\/arguments>\s*<\/function>\s*$/i);
  if (!match) return null;
  let payload: unknown;
  try { payload = JSON.parse(match[2].trim()); }
  catch { throw new Error('The provider returned invalid JSON inside a legacy <function> tool call.'); }
  const tuple = Array.isArray(payload) ? payload : null;
  const name = match[1] || (typeof tuple?.[0] === 'string' ? tuple[0] : '');
  const args = tuple ? tuple[1] : payload;
  if (!name) throw new Error('The provider legacy <function> tool call is missing a tool name.');
  if (!TOOL_NAMES.has(name as AgentToolName)) throw new Error(`Unsupported Agent tool: ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
  return { id: 'legacy-1', name: name as AgentToolName, arguments: args as Record<string, unknown> };
}

export function parseContextSelectors(prompt: string): ContextSelector[] {
  const selectors: ContextSelector[] = [];
  const seen = new Set<string>();
  for (const match of prompt.matchAll(/@(file|folder|symbol):(?:"([^"]+)"|'([^']+)'|([^\s,;]+))/gi)) {
    const selector = { type: match[1].toLowerCase() as ContextSelector['type'], value: (match[2] || match[3] || match[4]).trim() };
    const key = `${selector.type}:${selector.value}`;
    if (selector.value && !seen.has(key)) { seen.add(key); selectors.push(selector); }
  }
  return selectors;
}

/**
 * Extract the typed patch envelope emitted by CURSEM Agent/Edit modes. Keeping
 * the protocol JSON-based avoids heuristic Markdown fence parsing and supports
 * create, modify, and delete operations across multiple files. The server is
 * still authoritative: it resolves every path and freezes current file hashes
 * before the review UI can apply anything.
 */
export function parseAgentPatch(text: string, activePath?: string | null): ParsedAgentPatch | null {
  const envelope = text.match(/<cursem-patch>([\s\S]*?)<\/cursem-patch>/i);
  if (envelope) {
    let payload: unknown;
    try { payload = JSON.parse(envelope[1].trim()); }
    catch { throw new Error('The provider returned invalid JSON inside <cursem-patch>.'); }
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { changes?: unknown }).changes)) {
      throw new Error('The patch envelope must contain a changes array.');
    }
    const changes = validateChanges((payload as { changes: unknown[] }).changes);
    return { changes, explanation: text.replace(envelope[0], '').trim() };
  }

  // Backward compatibility for providers that follow the original single-file
  // Edit prompt while conversations are upgraded to the new typed protocol.
  const legacy = text.match(/<cursem-file(?:\s[^>]*)?>([\s\S]*?)<\/cursem-file>/i);
  if (legacy && activePath) {
    return {
      changes: [{ path: activePath, content: legacy[1].replace(/^\n/, '').replace(/\n$/, '') }],
      explanation: text.replace(legacy[0], '').trim(),
    };
  }
  return null;
}

function validateChanges(rawChanges: unknown[]): AgentPatchChange[] {
  if (rawChanges.length === 0) throw new Error('The patch changes array is empty.');
  if (rawChanges.length > MAX_PATCH_FILES) throw new Error(`The patch exceeds ${MAX_PATCH_FILES} files.`);
  const seen = new Set<string>();
  return rawChanges.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('Every patch change must be an object.');
    const path = (raw as { path?: unknown }).path;
    const content = (raw as { content?: unknown }).content;
    if (typeof path !== 'string' || !path.trim()) throw new Error('Every patch change requires a path.');
    if (content !== null && typeof content !== 'string') throw new Error(`Patch content for ${path} must be a string or null.`);
    const normalized = path.trim().replace(/^\.\//, '');
    if (seen.has(normalized)) throw new Error(`Duplicate patch path: ${normalized}`);
    seen.add(normalized);
    return { path: normalized, content };
  });
}
