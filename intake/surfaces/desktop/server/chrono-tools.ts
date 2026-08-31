/**
 * Chrono tools — agent-facing time manipulation via ops/chrono/chrono_sandbox.py.
 *
 * Safety model (what the agent may do unaided vs. never):
 *   SAFE  : snapshot, log, ledger, forks, diff — read-only or additive.
 *   SAFE  : fork — creates worktrees, touches nothing existing.
 *   GUARDED: rewind — always takes a pre-rewind safety snapshot (the CLI does
 *            this itself) and defaults to --keep (refuses to clobber dirty
 *            uncommitted work unless hard=true is passed explicitly).
 *   GUARDED: merge_winner, prune — destructive to fork timelines only, never
 *            to the main line. Require an exact fork name (or all=true for prune).
 *
 * Every mutating tool call already produces a micro-snapshot (chrono-hook.ts),
 * so the agent always has a T-1 recovery point before its own changes.
 */

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

const CHRONO_PY = process.env.CHRONO_PY || (existsSync('/opt/homebrew/bin/python3') ? '/opt/homebrew/bin/python3' : 'python3');
const WORKSTATION_ROOT = process.env.FLOYD_WORKSTATION_ROOT || path.resolve(process.cwd(), '..', '..', '..');
const CHRONO_CLI = process.env.CHRONO_CLI || path.join(WORKSTATION_ROOT, 'ops', 'chrono', 'chrono_sandbox.py');

/** Repos the agent may time-manipulate. Mirrors the frame's CHRONO_SURFACES. */
const CHRONO_REPOS: Record<string, string> = {
  desktop: path.join(WORKSTATION_ROOT, 'intake', 'surfaces', 'desktop'),
  ide: path.join(WORKSTATION_ROOT, 'intake', 'surfaces', 'ide'),
  launcher: path.join(WORKSTATION_ROOT, 'intake', 'surfaces', 'launcher'),
  pty: path.join(WORKSTATION_ROOT, 'intake', 'surfaces', 'pty'),
  workstation: WORKSTATION_ROOT,
};

const NAME_RE = /^[\w-]{1,40}$/;

function run(repo: string, argv: string[]): Promise<{ success: boolean; result?: any; error?: string }> {
  return new Promise((done) => {
    execFile(CHRONO_PY, [CHRONO_CLI, repo, ...argv], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) return done({ success: false, error: (stderr || String(err)).slice(0, 500) });
      try {
        const r = JSON.parse(stdout);
        done(r.ok === false ? { success: false, error: r.error } : { success: true, result: r });
      } catch {
        done({ success: false, error: `chrono returned non-JSON: ${String(stdout).slice(0, 200)}` });
      }
    });
  });
}

function repoFor(surface: unknown): string | null {
  return CHRONO_REPOS[String(surface || 'desktop')] || null;
}

export function chronoToolsAvailable(): boolean {
  return existsSync(CHRONO_CLI);
}

export const CHRONO_TOOLS = [
  {
    name: 'chrono_snapshot',
    description: 'Take a shadow snapshot of a surface repo: the full working tree (including uncommitted and untracked files) is captured on a hidden ref (refs/chrono/snapshots). The branch, git log, git status, and the index are NEVER touched — snapshots are invisible to normal git. Automatic after every mutating tool call; call manually before risky multi-step work. Safe: never loses or commits work.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: { type: 'string', enum: Object.keys(CHRONO_REPOS), description: 'Which repo to snapshot (default desktop)' },
        message: { type: 'string', description: 'Optional snapshot label, e.g. "before refactor of X"' },
      },
    },
  },
  {
    name: 'chrono_log',
    description: 'List shadow snapshots (newest first) with sha, time, and subject. These are the valid chrono_rewind targets. Branch commits are NOT rewind targets — use this, not git log. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: { type: 'string', enum: Object.keys(CHRONO_REPOS) },
        n: { type: 'number', description: 'How many entries (default 15, max 60)' },
      },
    },
  },
  {
    name: 'chrono_rewind',
    description: 'Restore the working tree of a surface repo to a snapshot state. HEAD and the branch are never moved — this only rewrites files (adds, restores, and deletes to match the snapshot). A pre-rewind safety snapshot is always taken automatically first and the result includes a recovery_hint, so every rewind is undoable. Defaults to the latest snapshot. Use chrono_log to pick a target sha.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: { type: 'string', enum: Object.keys(CHRONO_REPOS) },
        to: { type: 'string', description: 'Target snapshot sha from chrono_log (default: latest snapshot)' },
      },
    },
  },
  {
    name: 'chrono_fork',
    description: 'Chrono-fork: create N parallel worktrees (alternate timelines) off the current commit. Each fork is an isolated directory where changes do not touch the main line. Use for trying multiple approaches in parallel (ensemble), then chrono_diff to compare and chrono_merge_winner to keep the best. Safe: purely additive.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: { type: 'string', enum: Object.keys(CHRONO_REPOS) },
        names: { type: 'array', items: { type: 'string' }, description: 'Fork names, e.g. ["approach-a","approach-b"]. Letters/digits/dash/underscore only.' },
      },
      required: ['names'],
    },
  },
  {
    name: 'chrono_forks',
    description: 'List live forks of a surface repo with their head, dirty state, and diffstat vs base. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { surface: { type: 'string', enum: Object.keys(CHRONO_REPOS) } },
    },
  },
  {
    name: 'chrono_diff',
    description: 'Show one fork\'s full diff against its base commit. Use to evaluate which fork won before chrono_merge_winner. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: { type: 'string', enum: Object.keys(CHRONO_REPOS) },
        name: { type: 'string', description: 'Fork name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'chrono_merge_winner',
    description: 'Commit the named fork\'s changes into the main line and prune ALL other forks (losing timelines are deleted). Destructive to the losing forks only — the main line and winner are preserved. Confirm the winner with chrono_diff first.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: { type: 'string', enum: Object.keys(CHRONO_REPOS) },
        name: { type: 'string', description: 'Winning fork name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'chrono_prune',
    description: 'Delete a fork (or all forks with all=true) WITHOUT merging. The fork\'s changes are lost. Main line untouched. Use when an experiment is abandoned.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: { type: 'string', enum: Object.keys(CHRONO_REPOS) },
        name: { type: 'string', description: 'Fork to delete' },
        all: { type: 'boolean', description: 'Delete every fork' },
      },
    },
  },
  {
    name: 'chrono_ledger',
    description: 'Read the JSON execution ledger of chrono operations (snapshots, rewinds, forks, merges) for a surface. Read-only audit trail.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: { type: 'string', enum: Object.keys(CHRONO_REPOS) },
        n: { type: 'number', description: 'How many entries (default 20, max 100)' },
      },
    },
  },
];

const CHRONO_TOOL_NAMES = new Set(CHRONO_TOOLS.map((t) => t.name));

export function isChronoTool(name: string): boolean {
  return CHRONO_TOOL_NAMES.has(name);
}

export async function executeChronoTool(name: string, args: Record<string, unknown>): Promise<{ success: boolean; result?: any; error?: string }> {
  const repo = repoFor(args.surface);
  if (!repo) return { success: false, error: `Unknown surface: ${args.surface}. Valid: ${Object.keys(CHRONO_REPOS).join(', ')}` };
  if (!chronoToolsAvailable()) return { success: false, error: `chrono CLI missing at ${CHRONO_CLI}` };

  switch (name) {
    case 'chrono_snapshot':
      return run(repo, ['snapshot', ...(args.message ? ['-m', String(args.message)] : [])]);
    case 'chrono_log': {
      // Shadow snapshot timeline — these are the rewind targets.
      const n = Math.min(Number(args.n) || 15, 60);
      return run(repo, ['timeline', '-n', String(n)]);
    }
    case 'chrono_rewind':
      return run(repo, ['rewind', ...(args.to ? ['--to', String(args.to)] : [])]);
    case 'chrono_fork': {
      const names = Array.isArray(args.names) ? args.names.map(String) : [];
      if (!names.length || names.some((n) => !NAME_RE.test(n))) {
        return { success: false, error: 'names must be 1+ strings of letters/digits/dash/underscore (max 40 chars)' };
      }
      return run(repo, ['fork', ...names]);
    }
    case 'chrono_forks':
      return run(repo, ['forks']);
    case 'chrono_diff':
      if (!NAME_RE.test(String(args.name || ''))) return { success: false, error: 'invalid fork name' };
      return run(repo, ['diff', String(args.name)]);
    case 'chrono_merge_winner':
      if (!NAME_RE.test(String(args.name || ''))) return { success: false, error: 'invalid fork name' };
      return run(repo, ['merge-winner', String(args.name)]);
    case 'chrono_prune':
      if (args.all === true) return run(repo, ['prune', '--all']);
      if (!NAME_RE.test(String(args.name || ''))) return { success: false, error: 'pass a fork name or all=true' };
      return run(repo, ['prune', String(args.name)]);
    case 'chrono_ledger':
      return run(repo, ['ledger', '-n', String(Math.min(Number(args.n) || 20, 100))]);
    default:
      return { success: false, error: `unknown chrono tool: ${name}` };
  }
}
