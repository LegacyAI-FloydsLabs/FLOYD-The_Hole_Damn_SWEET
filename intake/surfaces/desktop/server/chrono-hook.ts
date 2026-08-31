/**
 * Chrono hook — micro-snapshot per mutating tool call.
 *
 * The frame's CHRONO tab (time sandbox) expects a T-1 recovery point for every
 * mutating tool call an agent makes. This module fires a linear micro-snapshot
 * via ops/chrono/chrono_sandbox.py on the git repo enclosing the mutated path.
 *
 * Non-blocking and failure-tolerant: a chrono failure never breaks the tool
 * call itself. Snapshots are serialized per repo to avoid git lock races.
 */

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

const CHRONO_PY = process.env.CHRONO_PY || (existsSync('/opt/homebrew/bin/python3') ? '/opt/homebrew/bin/python3' : 'python3');
const WORKSTATION_ROOT = process.env.FLOYD_WORKSTATION_ROOT || path.resolve(process.cwd(), '..', '..', '..');
const CHRONO_CLI = process.env.CHRONO_CLI || path.join(WORKSTATION_ROOT, 'ops', 'chrono', 'chrono_sandbox.py');

/** Tools whose success mutates the filesystem and deserves a recovery point. */
const MUTATING_TOOLS = new Set([
  'write_file', 'edit_block', 'smart_replace', 'create_directory', 'delete_file',
  'move_file', 'execute_command', 'start_process', 'interact_with_process',
  'execute_code', 'apply_patch',
]);

/** Args fields that may carry the mutated path, in preference order. */
const PATH_FIELDS = ['path', 'file_path', 'destination', 'source', 'cwd', 'working_dir'];

export function chronoEnabled(): boolean {
  return existsSync(CHRONO_CLI) && process.env.CHRONO_SNAPSHOTS !== '0';
}

/** Walk up from a path to the enclosing git repo root, or null. */
function repoFor(p: string): string | null {
  try {
    let dir = path.resolve(p);
    if (!existsSync(dir)) dir = path.dirname(dir); // file may be new
    for (let i = 0; i < 40 && dir.length > 1; i++) {
      if (existsSync(path.join(dir, '.git'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* fall through */ }
  return null;
}

function pathFromArgs(args: Record<string, unknown>): string | null {
  for (const f of PATH_FIELDS) {
    const v = args[f];
    if (typeof v === 'string' && v.startsWith('/')) return v;
  }
  // execute_command / execute_code without a cwd: snapshot the process cwd.
  return process.cwd();
}

// Serialize snapshots per repo so concurrent tool calls can't race git index.lock.
const repoQueues = new Map<string, Promise<void>>();

function snapshotRepo(repo: string, message: string): void {
  const prev = repoQueues.get(repo) || Promise.resolve();
  const next = prev.then(() => new Promise<void>((done) => {
    execFile(CHRONO_PY, [CHRONO_CLI, repo, 'snapshot', '-m', message],
      { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) console.error(`[chrono] snapshot failed for ${repo}: ${(stderr || String(err)).slice(0, 200)}`);
        else {
          try {
            const r = JSON.parse(stdout);
            if (r.snapshot) console.log(`[chrono] ${repo}: ${r.snapshot.slice(0, 8)} — ${message}`);
          } catch { /* non-JSON output, ignore */ }
        }
        done();
      });
  }));
  repoQueues.set(repo, next);
}

/**
 * Fire-and-forget micro-snapshot after a successful mutating tool call.
 * Never throws, never blocks the caller.
 */
export function chronoAfterToolCall(tool: string, args: Record<string, unknown>, success: boolean): void {
  try {
    if (!success || !MUTATING_TOOLS.has(tool) || !chronoEnabled()) return;
    const p = pathFromArgs(args);
    if (!p) return;
    const repo = repoFor(p);
    if (!repo) return;
    snapshotRepo(repo, `chrono: after ${tool}`);
  } catch (err: any) {
    console.error(`[chrono] hook error: ${err.message}`);
  }
}
