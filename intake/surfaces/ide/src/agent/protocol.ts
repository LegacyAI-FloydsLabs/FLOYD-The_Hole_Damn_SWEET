import type { AgentPatchChange, ContextSelector } from '@/platform';

const MAX_PATCH_FILES = 128;

export interface ParsedAgentPatch {
  changes: AgentPatchChange[];
  explanation: string;
}

export type AgentToolName = 'search' | 'read_file' | 'list_dir' | 'git_diff' | 'run_task' | 'rules' | 'mcp';
export interface AgentToolCall { id: string; name: AgentToolName; arguments: Record<string, unknown> }

const TOOL_NAMES = new Set<AgentToolName>(['search', 'read_file', 'list_dir', 'git_diff', 'run_task', 'rules', 'mcp']);

// ─── Structured agent event vocabulary (Phase 4 S1) ────────────────────
//
// The runner emits these typed events through gateway.agentAppendEvent so
// they persist in the SQLite run_events table, and mirrors them through its
// onToolEvent callback so the chat store can render tool-call cards without
// flattening evidence into text ticks.

export interface AgentToolBeginEvent { type: 'tool_begin'; id: string; name: AgentToolName; args: Record<string, unknown> }
export interface AgentToolProgressEvent { type: 'tool_progress'; id: string; name: AgentToolName; note: string }
export interface AgentToolEndEvent { type: 'tool_end'; id: string; name: AgentToolName; result?: unknown; error?: string }
export type AgentToolEvent = AgentToolBeginEvent | AgentToolProgressEvent | AgentToolEndEvent;

export type AgentAskMethod = 'select' | 'confirm' | 'input';

/** A blocking agent→user question emitted as <cursem-ask>{...}</cursem-ask>. */
export interface AgentAskRequest {
  id: string;
  method: AgentAskMethod;
  question: string;
  /** Choices for method 'select'. */
  options?: string[];
  /** Optional supporting detail shown under the question. */
  detail?: string;
}

export interface AgentAskResponse {
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

/** A plan-mode proposal emitted as <cursem-plan>{summary, steps[]}</cursem-plan>. */
export interface AgentPlan {
  summary: string;
  steps: string[];
}

const ASK_METHODS = new Set<AgentAskMethod>(['select', 'confirm', 'input']);
const MAX_PLAN_STEPS = 64;
const MAX_ASK_OPTIONS = 32;

function parseEnvelope<T>(text: string, tag: string, validate: (payload: Record<string, unknown>) => T): T | null {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!match) return null;
  let payload: unknown;
  try { payload = JSON.parse(match[1].trim()); }
  catch { throw new Error(`The provider returned invalid JSON inside <${tag}>.`); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`The <${tag}> envelope must contain an object.`);
  return validate(payload as Record<string, unknown>);
}

/** Parse a blocking <cursem-ask> question. Returns null when the text holds none. */
export function parseAgentAsk(text: string): AgentAskRequest | null {
  return parseEnvelope(text, 'cursem-ask', (value) => {
    if (typeof value.id !== 'string' || !value.id.trim()) throw new Error('The ask request requires an id.');
    if (!ASK_METHODS.has(value.method as AgentAskMethod)) throw new Error(`Unsupported ask method: ${String(value.method)}`);
    if (typeof value.question !== 'string' || !value.question.trim()) throw new Error('The ask request requires a question.');
    const options = value.options === undefined ? undefined : value.options;
    if (options !== undefined && (!Array.isArray(options) || options.length > MAX_ASK_OPTIONS || options.some((option) => typeof option !== 'string'))) {
      throw new Error('Ask options must be a string array.');
    }
    if ((value.method as AgentAskMethod) === 'select' && (!options || options.length === 0)) throw new Error('A select ask request requires options.');
    return {
      id: value.id,
      method: value.method as AgentAskMethod,
      question: value.question.trim(),
      ...(options ? { options: options as string[] } : {}),
      ...(typeof value.detail === 'string' && value.detail.trim() ? { detail: value.detail.trim() } : {}),
    };
  });
}

/** Parse a plan-mode <cursem-plan> proposal. Returns null when the text holds none. */
export function parseAgentPlan(text: string): AgentPlan | null {
  return parseEnvelope(text, 'cursem-plan', (value) => {
    if (typeof value.summary !== 'string' || !value.summary.trim()) throw new Error('The plan requires a summary.');
    if (!Array.isArray(value.steps) || value.steps.length === 0) throw new Error('The plan requires a steps array.');
    if (value.steps.length > MAX_PLAN_STEPS) throw new Error(`The plan exceeds ${MAX_PLAN_STEPS} steps.`);
    const steps = value.steps.map((step) => {
      if (typeof step !== 'string' || !step.trim()) throw new Error('Every plan step must be a non-empty string.');
      return step.trim();
    });
    return { summary: value.summary.trim(), steps };
  });
}

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
