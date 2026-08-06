// ─── Tool-call card (Phase 4 S3) ────────────────────────────────────────
//
// One card per structured tool event: a collapsed verb + summary one-liner
// that expands into a kind-appropriate body — command output for run_task,
// content/result previews for read_file and search, a colored unified diff
// for git_diff, JSON for the rest. Running cards shimmer; failures render a
// distinct error state. Result payloads are soft-parsed throughout because
// they arrive as unknown evidence from the runner.

import { useState, type ReactNode } from 'react';
import { Icon } from '@/components/Icon';
import type { ToolCallState } from '@/store/chatStore';
import { UnifiedDiffView } from './DiffView';

const MAX_PREVIEW_CHARS = 4_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function clip(text: string, max = MAX_PREVIEW_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n… [truncated]` : text;
}

/** Verb + one-line summary for the collapsed card header. */
export function toolSummary(tool: Pick<ToolCallState, 'name' | 'args'>): { verb: string; summary: string } {
  const args = tool.args;
  switch (tool.name) {
    case 'search': return { verb: 'Searched', summary: `"${String(args.query ?? '')}"` };
    case 'read_file': return { verb: 'Read', summary: String(args.path ?? '') };
    case 'list_dir': return { verb: 'Listed', summary: String(args.path ?? 'workspace root') };
    case 'git_diff': return { verb: 'Inspected diff', summary: typeof args.path === 'string' ? args.path : 'working tree' };
    case 'run_task': {
      const rest = Array.isArray(args.args) ? args.args.map(String).join(' ') : '';
      return { verb: 'Ran', summary: `${String(args.executable ?? '')}${rest ? ` ${rest}` : ''}`.trim() };
    }
    case 'rules': return { verb: 'Loaded rules', summary: typeof args.path === 'string' && args.path ? args.path : 'workspace' };
    case 'mcp': return { verb: 'Used', summary: `${String(args.server ?? '?')}.${String(args.tool ?? '?')}` };
    default: return { verb: 'Used', summary: tool.name };
  }
}

function JsonBlock({ value }: { value: unknown }) {
  let text: string;
  try { text = JSON.stringify(value, null, 2) ?? ''; }
  catch { text = String(value); }
  return <pre className="tool-card-pre">{clip(text)}</pre>;
}

function RunTaskBody({ result }: { result: unknown }) {
  const record = asRecord(result);
  if (!record) return <JsonBlock value={result} />;
  const exitCode = typeof record.exitCode === 'number' ? record.exitCode : null;
  return (
    <div className="tool-card-body-stack">
      {exitCode !== null && <div className={`tool-card-exit ${exitCode === 0 ? 'ok' : 'bad'}`}>exit code {exitCode}{typeof record.durationMs === 'number' ? ` · ${record.durationMs}ms` : ''}</div>}
      {typeof record.stdout === 'string' && record.stdout && <><label>stdout</label><pre className="tool-card-pre">{clip(record.stdout)}</pre></>}
      {typeof record.stderr === 'string' && record.stderr && <><label>stderr</label><pre className="tool-card-pre error">{clip(record.stderr)}</pre></>}
      {exitCode === null && <JsonBlock value={result} />}
    </div>
  );
}

function ReadFileBody({ result }: { result: unknown }) {
  const record = asRecord(result);
  const items = Array.isArray(record?.items) ? record.items : [];
  if (!items.length) return <JsonBlock value={result} />;
  return (
    <div className="tool-card-body-stack">
      {items.map((raw, index) => {
        const item = asRecord(raw);
        if (!item) return null;
        return (
          <div key={index}>
            <label>{String(item.path ?? 'file')}{typeof item.chars === 'number' ? ` · ${item.chars.toLocaleString()} chars` : ''}</label>
            {typeof item.content === 'string' && <pre className="tool-card-pre">{clip(item.content)}</pre>}
          </div>
        );
      })}
    </div>
  );
}

function SearchBody({ result }: { result: unknown }) {
  if (!Array.isArray(result) || !result.length) return <JsonBlock value={result} />;
  return (
    <div className="tool-card-body-stack">
      {result.slice(0, 12).map((raw, index) => {
        const item = asRecord(raw);
        if (!item) return null;
        return (
          <div key={index} className="tool-card-search-hit">
            <strong>{String(item.path ?? '?')}</strong>
            {typeof item.snippet === 'string' && item.snippet && <span>{clip(item.snippet, 240)}</span>}
          </div>
        );
      })}
    </div>
  );
}

function ListDirBody({ result }: { result: unknown }) {
  if (!Array.isArray(result) || !result.length) return <JsonBlock value={result} />;
  return (
    <div className="tool-card-listdir">
      {result.slice(0, 100).map((raw, index) => {
        const item = asRecord(raw);
        if (!item) return null;
        return <span key={index} className={item.type === 'dir' ? 'dir' : ''}>{String(item.name ?? '?')}{item.type === 'dir' ? '/' : ''}</span>;
      })}
    </div>
  );
}

function GitDiffBody({ result }: { result: unknown }) {
  const record = asRecord(result);
  const diff = typeof record?.diff === 'string' ? record.diff : '';
  if (!diff.trim()) return <div className="tool-card-empty">No working-tree changes.</div>;
  return <UnifiedDiffView diff={diff} />;
}

function ToolBody({ tool }: { tool: ToolCallState }) {
  if (tool.status === 'running') return <div className="tool-card-empty">Running…</div>;
  if (tool.status === 'failed') return <pre className="tool-card-pre error">{tool.error || 'Tool failed.'}</pre>;
  switch (tool.name) {
    case 'run_task': return <RunTaskBody result={tool.result} />;
    case 'read_file': return <ReadFileBody result={tool.result} />;
    case 'search': return <SearchBody result={tool.result} />;
    case 'list_dir': return <ListDirBody result={tool.result} />;
    case 'git_diff': return <GitDiffBody result={tool.result} />;
    default: return <JsonBlock value={tool.result} />;
  }
}

export function ToolCard({ tool, defaultOpen = false }: { tool: ToolCallState; defaultOpen?: boolean }): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  const { verb, summary } = toolSummary(tool);
  return (
    <article className={`tool-card ${tool.status}`} data-tool={tool.name} data-status={tool.status}>
      <button
        type="button"
        className="tool-card-header"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label={`${verb} ${summary}`}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        <span className="tool-card-verb">{verb}</span>
        <span className="tool-card-summary">{summary}</span>
        {tool.status === 'running' && <span className="tool-card-shimmer" aria-label="running" />}
        {tool.status === 'failed' && <Icon name="warning" size={12} />}
        {tool.status === 'completed' && <Icon name="check" size={12} />}
      </button>
      {open && <div className="tool-card-body"><ToolBody tool={tool} /></div>}
    </article>
  );
}
