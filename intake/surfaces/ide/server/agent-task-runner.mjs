import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

const ALLOWED_EXECUTABLES = new Set(['node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'git', 'rg', 'tsc', 'vite', 'vitest', 'pytest', 'python3', 'cargo', 'rustc', 'go', 'make']);
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'grep', 'ls-files', 'rev-parse', 'branch']);
const MAX_ARGS = 128;
const MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * Executes an approved argument vector without a shell. The model never sends
 * a command string, so pipes, redirects, substitutions, and compound commands
 * are impossible. The UI obtains explicit approval before calling this runner;
 * the host independently enforces executable, argument, cwd, time, and output
 * limits. Git is read-only here—mutating Git operations retain their dedicated
 * confirmation-gated host routes.
 */
export function createAgentTaskRunner({ workspaceRoot }) {
  let root = workspaceRoot;
  return {
    setWorkspaceRoot(nextRoot) { root = nextRoot; },
    async run(request, signal) {
      const executable = String(request?.executable || '').trim();
      const args = validateArgs(request?.args);
      if (!ALLOWED_EXECUTABLES.has(executable)) throw httpError(403, `Agent executable is not allowed: ${executable || '(empty)'}`);
      if (executable === 'git' && (!args[0] || !READ_ONLY_GIT.has(args[0]) || (args[0] === 'branch' && args.length > 1))) {
        throw httpError(403, 'Agent Git tasks are read-only. Use the dedicated Git UI for mutations.');
      }
      const cwd = await confinedDirectory(root, request?.cwd || root);
      const timeoutMs = Math.max(1000, Math.min(120_000, Number(request?.timeoutMs) || 60_000));
      const startedAt = Date.now();
      return await new Promise((resolvePromise, reject) => {
        const child = execFile('/usr/bin/env', [executable, ...args], {
          cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT, timeout: timeoutMs, signal,
          env: { ...process.env, CURSEM_AGENT_TASK: '1', NO_COLOR: '1' },
        }, (error, stdout, stderr) => {
          if (error?.name === 'AbortError') { reject(error); return; }
          resolvePromise({
            executable, args, cwd, stdout: String(stdout || ''), stderr: String(stderr || ''),
            exitCode: Number.isInteger(error?.code) ? error.code : error ? 1 : 0,
            signal: error?.signal || null, durationMs: Date.now() - startedAt,
          });
        });
        signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
      });
    },
  };
}

function validateArgs(value) {
  if (!Array.isArray(value) || value.length > MAX_ARGS) throw httpError(400, `args must be an array with at most ${MAX_ARGS} entries.`);
  return value.map((arg) => {
    if (typeof arg !== 'string' || arg.length > 4096 || /[\0\r\n]/.test(arg)) throw httpError(400, 'Every task argument must be a bounded single-line string.');
    return arg;
  });
}

async function confinedDirectory(root, requested) {
  const candidate = resolve(root, requested);
  const resolved = await realpath(candidate);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) throw httpError(403, 'Task cwd escapes the workspace.');
  return resolved;
}
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
