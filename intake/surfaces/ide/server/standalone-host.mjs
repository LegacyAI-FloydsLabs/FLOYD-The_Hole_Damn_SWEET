import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { watch } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { createAgentStore } from './agent-store.mjs';
import { createPatchTransactions } from './patch-transactions.mjs';
import { createRepositoryContext } from './repository-context.mjs';
import { createAgentTaskRunner } from './agent-task-runner.mjs';
import { createMcpManager } from './mcp-manager.mjs';
import { createMigrationService } from './migration-service.mjs';
import { createTaskDiscovery } from './task-discovery.mjs';

const execFileAsync = promisify(execFile);
const MAX_BODY_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
// Binary reads feed document/image viewers; base64 inflates ~33% and the
// payload crosses the JSON channel, so cap well below MAX_FILE_BYTES.
const MAX_BINARY_FILE_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;

// Admitted-surface identity for Floyd Core discovery: reports the git commit
// this copy actually runs so Core can verify the admitted source.
import { execFileSync } from 'node:child_process';
const SURFACE_IDENTITY = (() => {
  const surfaceId = process.env.FLOYD_SURFACE_ID || 'ide';
  let sourceRoot = process.env.FLOYD_SURFACE_SOURCE_ROOT || process.cwd();
  let sourceCommit = process.env.FLOYD_SOURCE_COMMIT || process.env.FLOYD_SURFACE_COMMIT || '';
  try {
    if (!sourceCommit) {
      sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
    }
  } catch { /* non-git deployment */ }
  return { surface_id: surfaceId, source_root: sourceRoot, source_commit: sourceCommit };
})();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Trusted loopback host for the standalone IDE.
 *
 * Browser code never receives a general-purpose command or filesystem proxy.
 * Every route below maps to a narrow operation, and every path is resolved
 * through WorkspaceBoundary before touching disk. Existing paths are checked
 * with realpath(), which rejects symlinks that escape the approved root.
 */
export async function createStandaloneHost(options = {}) {
  const boundary = new WorkspaceBoundary();
  const configuredRoot = options.initialWorkspaceRoot || process.env.CURSEM_WORKSPACE_ROOT || process.cwd();
  await boundary.setRoot(configuredRoot);
  const terminalEndpoint = options.terminalEndpoint || process.env.CURSEM_TERMINAL_URL || '';
  const terminalToken = options.terminalToken || process.env.CURSEM_TERMINAL_TOKEN || '';
  const chooseWorkspace = options.chooseWorkspace || chooseWorkspaceMacOS;
  const lspManager = options.lspManager;
  const debugManager = options.debugManager;
  const watchers = new Set();
  let agentStore = options.agentStore || createAgentStore({ workspaceRoot: boundary.root, databasePath: options.agentDatabasePath });
  let patchTransactions = createPatchTransactions({ boundary, store: agentStore });
  const repositoryContext = options.repositoryContext || createRepositoryContext({ workspaceRoot: boundary.root });
  const agentTaskRunner = options.agentTaskRunner || createAgentTaskRunner({ workspaceRoot: boundary.root });
  const mcpManager = options.mcpManager || createMcpManager({ workspaceRoot: boundary.root });
  const migrationService = options.migrationService || createMigrationService();
  const taskDiscovery = options.taskDiscovery || createTaskDiscovery({ workspaceRoot: boundary.root });

  const resetAgentState = () => {
    if (options.agentStore) return;
    agentStore.close();
    agentStore = createAgentStore({ workspaceRoot: boundary.root });
    patchTransactions = createPatchTransactions({ boundary, store: agentStore });
  };

  async function applyWorkspaceRoot(selected) {
    await boundary.setRoot(selected);
    debugManager?.setWorkspaceRoot(boundary.root);
    repositoryContext.setWorkspaceRoot(boundary.root);
    agentTaskRunner.setWorkspaceRoot(boundary.root);
    taskDiscovery.setWorkspaceRoot(boundary.root);
    await mcpManager.setWorkspaceRoot(boundary.root);
    resetAgentState();
    const workspace = await describeWorkspace(boundary.root);
    await options.onWorkspaceChanged?.(boundary.root);
    return workspace;
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, status: 'ok', mode: 'standalone', workspaceRoot: boundary.root, identity: SURFACE_IDENTITY });
      }
      if (url.pathname === '/api/platform/auth' && req.method === 'GET') {
        return sendJson(res, 200, {
          token: 'loopback-session', expiresAt: Date.now() + 3_600_000,
          user: { id: 'local', name: 'Local User', roles: ['owner'] },
        });
      }
      if (url.pathname === '/api/platform/workspace' && req.method === 'GET') {
        return sendJson(res, 200, await describeWorkspace(boundary.root));
      }
      if (url.pathname === '/api/platform/workspace/select' && req.method === 'POST') {
        const selected = await chooseWorkspace(boundary.root);
        if (!selected) return sendJson(res, 200, { workspace: null });
        return sendJson(res, 200, { workspace: await applyWorkspaceRoot(selected) });
      }
      if (url.pathname === '/api/platform/agent' && req.method === 'GET') return sendJson(res, 200, null);
      if (url.pathname === '/api/platform/theme' && req.method === 'GET') return sendJson(res, 200, null);
      if (url.pathname === '/api/platform/permission' && req.method === 'POST') {
        const body = await readJson(req);
        const allowed = typeof body.resource === 'string' && typeof body.action === 'string';
        return sendJson(res, 200, { granted: allowed });
      }

      if (url.pathname === '/api/agent/threads' && req.method === 'GET') {
        return sendJson(res, 200, { threads: agentStore.listThreads(url.searchParams.get('limit')) });
      }
      if (url.pathname === '/api/agent/threads' && req.method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 201, agentStore.createThread(body.title));
      }
      if (url.pathname === '/api/agent/thread' && req.method === 'GET') {
        const thread = agentStore.getThread(requiredQuery(url, 'id'));
        if (!thread) throw new HttpError(404, 'Thread not found.');
        return sendJson(res, 200, thread);
      }
      if (url.pathname === '/api/agent/messages' && req.method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 201, agentStore.addMessage(body.threadId, body.role, body.content, body.metadata));
      }
      if (url.pathname === '/api/agent/runs' && req.method === 'POST') {
        return sendJson(res, 201, agentStore.createRun(await readJson(req)));
      }
      if (url.pathname === '/api/agent/run' && req.method === 'GET') {
        const run = agentStore.getRun(requiredQuery(url, 'id'));
        if (!run) throw new HttpError(404, 'Run not found.');
        return sendJson(res, 200, run);
      }
      if (url.pathname === '/api/agent/run/update' && req.method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, agentStore.updateRun(body.runId, body.status, body.summary));
      }
      if (url.pathname === '/api/agent/events' && req.method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 201, agentStore.appendEvent(body.runId, body.type, body.payload));
      }
      if (url.pathname === '/api/agent/patch/preview' && req.method === 'POST') {
        return sendJson(res, 201, await patchTransactions.preview(await readJson(req)));
      }
      if (url.pathname === '/api/agent/patch/apply' && req.method === 'POST') {
        return sendJson(res, 200, await patchTransactions.apply(await readJson(req)));
      }
      if (url.pathname === '/api/agent/checkpoints' && req.method === 'GET') {
        return sendJson(res, 200, { checkpoints: agentStore.listCheckpoints(url.searchParams.get('limit')) });
      }
      if (url.pathname === '/api/agent/checkpoints/restore' && req.method === 'POST') {
        return sendJson(res, 200, await patchTransactions.restore(await readJson(req)));
      }
      if (url.pathname === '/api/agent/memories' && req.method === 'GET') {
        return sendJson(res, 200, { memories: agentStore.listMemories() });
      }
      if (url.pathname === '/api/agent/memories' && req.method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 201, agentStore.saveMemory(body.content));
      }
      if (url.pathname === '/api/agent/memories' && req.method === 'DELETE') {
        const removed = agentStore.deleteMemory(requiredQuery(url, 'id'));
        if (!removed) throw new HttpError(404, 'Memory not found.');
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname === '/api/agent/task' && req.method === 'POST') {
        const body = await readJson(req);
        const controller = new AbortController();
        const abort = () => { if (!res.writableEnded) controller.abort(); };
        req.once('aborted', abort); res.once('close', abort);
        try { return sendJson(res, 200, await agentTaskRunner.run(body, controller.signal)); }
        finally { req.off('aborted', abort); res.off('close', abort); }
      }

      if (url.pathname === '/api/context/status' && req.method === 'GET') {
        return sendJson(res, 200, repositoryContext.status());
      }
      if (url.pathname === '/api/context/refresh' && req.method === 'POST') {
        return sendJson(res, 200, await repositoryContext.refresh());
      }
      if (url.pathname === '/api/context/search' && req.method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, { results: await repositoryContext.search(body.query, body.limit) });
      }
      if (url.pathname === '/api/context/resolve' && req.method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, await repositoryContext.resolve(body.selectors, body.budgetChars));
      }
      if (url.pathname === '/api/context/rules' && req.method === 'GET') {
        return sendJson(res, 200, await repositoryContext.rules(url.searchParams.get('path') || ''));
      }

      if (url.pathname === '/api/mcp/servers' && req.method === 'GET') return sendJson(res, 200, { servers: await mcpManager.list() });
      if (url.pathname === '/api/mcp/connect' && req.method === 'POST') {
        const body = await readJson(req); return sendJson(res, 200, await mcpManager.connect(body.id));
      }
      if (url.pathname === '/api/mcp/disconnect' && req.method === 'POST') {
        const body = await readJson(req); return sendJson(res, 200, { disconnected: mcpManager.disconnect(body.id) });
      }
      if (url.pathname === '/api/mcp/tools' && req.method === 'GET') return sendJson(res, 200, { tools: await mcpManager.tools(requiredQuery(url, 'id')) });
      if (url.pathname === '/api/mcp/call' && req.method === 'POST') {
        const body = await readJson(req); return sendJson(res, 200, await mcpManager.call(body.id, body.name, body.arguments));
      }
      if (url.pathname === '/api/migration/preview' && req.method === 'GET') {
        return sendJson(res, 200, await migrationService.preview(requiredQuery(url, 'source')));
      }
      if (url.pathname === '/api/tasks' && req.method === 'GET') return sendJson(res, 200, { tasks: await taskDiscovery.list() });

      if (url.pathname === '/api/fs/read' && req.method === 'GET') {
        const target = await boundary.existing(requiredQuery(url, 'path'));
        const metadata = await stat(target);
        if (!metadata.isFile()) throw new HttpError(400, 'Path is not a file.');
        if (metadata.size > MAX_FILE_BYTES) throw new HttpError(413, `File exceeds ${MAX_FILE_BYTES} bytes.`);
        return sendJson(res, 200, { content: await readFile(target, 'utf8') });
      }
      if (url.pathname === '/api/fs/read-binary' && req.method === 'GET') {
        const target = await boundary.existing(requiredQuery(url, 'path'));
        const metadata = await stat(target);
        if (!metadata.isFile()) throw new HttpError(400, 'Path is not a file.');
        if (metadata.size > MAX_BINARY_FILE_BYTES) throw new HttpError(413, `File exceeds ${MAX_BINARY_FILE_BYTES} bytes.`);
        const data = await readFile(target);
        return sendJson(res, 200, { name: basename(target), size: metadata.size, mime: binaryMimeFor(target), data: data.toString('base64') });
      }
      if (url.pathname === '/api/fs/write' && req.method === 'POST') {
        const body = await readJson(req);
        if (typeof body.content !== 'string') throw new HttpError(400, 'content must be a string.');
        if (Buffer.byteLength(body.content) > MAX_FILE_BYTES) throw new HttpError(413, `File exceeds ${MAX_FILE_BYTES} bytes.`);
        const target = await boundary.writable(body.path);
        await writeFile(target, body.content, 'utf8');
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname === '/api/fs/list' && req.method === 'GET') {
        const directory = await boundary.existing(requiredQuery(url, 'path'));
        const entries = await import('node:fs/promises').then(({ readdir }) => readdir(directory, { withFileTypes: true }));
        const items = await Promise.all(entries.map(async (entry) => {
          const path = resolve(directory, entry.name);
          // One unstat-able entry (broken symlink, EACCES) must not sink the
          // whole listing — fall back to the dirent-derived shape. A symlink
          // that resolves to a directory reports 'dir' so symlinked folders
          // stay browsable; realpath confinement still applies downstream.
          let metadata = null;
          try { metadata = await stat(path); } catch { /* keep listing the rest */ }
          const type = entry.isSymbolicLink()
            ? (metadata?.isDirectory() ? 'dir' : 'symlink')
            : entry.isDirectory() ? 'dir' : 'file';
          return {
            name: entry.name,
            path,
            type,
            size: metadata ? metadata.size : 0,
            mtimeMs: metadata ? metadata.mtimeMs : 0,
          };
        }));
        return sendJson(res, 200, { items });
      }
      if (url.pathname === '/api/fs/stat' && req.method === 'GET') {
        const path = await boundary.existing(requiredQuery(url, 'path'));
        const metadata = await stat(path);
        return sendJson(res, 200, {
          path,
          type: metadata.isSymbolicLink() ? 'symlink' : metadata.isDirectory() ? 'dir' : 'file',
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
          mode: metadata.mode,
        });
      }
      if (url.pathname === '/api/fs/mkdir' && req.method === 'POST') {
        const body = await readJson(req);
        const target = await boundary.writable(body.path);
        await mkdir(target, { recursive: false });
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname === '/api/fs/rename' && req.method === 'POST') {
        const body = await readJson(req);
        const from = await boundary.existing(body.from);
        const to = await boundary.writable(body.to);
        await rename(from, to);
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname === '/api/fs/remove' && req.method === 'DELETE') {
        const target = await boundary.existing(requiredQuery(url, 'path'));
        if (target === boundary.root) throw new HttpError(400, 'The workspace root cannot be removed.');
        await rm(target, { recursive: true, force: false });
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname === '/api/fs/watch' && req.method === 'GET') {
        const target = await boundary.existing(requiredQuery(url, 'path'));
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        const watcher = watch(target, { recursive: true }, (eventType, filename) => {
          const path = resolve(target, String(filename || ''));
          if (!boundary.containsLexically(path)) return;
          const event = { type: eventType === 'rename' ? 'rename' : 'modify', path };
          if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        watchers.add(watcher);
        const close = () => { watcher.close(); watchers.delete(watcher); };
        req.once('close', close);
        watcher.once('error', close);
        return;
      }

      if (url.pathname.startsWith('/api/git/')) return await handleGit(req, res, url, boundary);

      if (url.pathname === '/api/terminal/auth' && req.method === 'GET') {
        if (!terminalEndpoint || !terminalToken) throw new HttpError(503, 'The local TerminalOne service is not running.');
        return sendJson(res, 200, { endpoint: terminalEndpoint, token: terminalToken, expiresAt: Date.now() + 300_000 });
      }

      if (url.pathname === '/api/lsp/servers' && req.method === 'GET') {
        return sendJson(res, 200, { servers: lspManager?.list() || languageServers() });
      }
      if (url.pathname === '/api/lsp/health' && req.method === 'GET') {
        const languageId = requiredQuery(url, 'language');
        return sendJson(res, 200, lspManager?.health(languageId) || { languageId, status: 'stopped' });
      }
      if (url.pathname === '/api/lsp/restart' && req.method === 'POST') {
        if (!lspManager) throw new HttpError(503, 'Language-server manager is unavailable.');
        const body = await readJson(req);
        lspManager.restart(body.languageId);
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === '/api/debug/launch' && req.method === 'POST') {
        if (!debugManager) throw new HttpError(503, 'Debug manager is unavailable.');
        return sendJson(res, 200, await debugManager.launch(await readJson(req)));
      }
      if (url.pathname === '/api/debug/control' && req.method === 'POST') {
        if (!debugManager) throw new HttpError(503, 'Debug manager is unavailable.');
        const body = await readJson(req); await debugManager.control(body.sessionId, body.command);
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname === '/api/debug/stack' && req.method === 'GET') {
        if (!debugManager) throw new HttpError(503, 'Debug manager is unavailable.');
        return sendJson(res, 200, { frames: await debugManager.stack(requiredQuery(url, 'sessionId')) });
      }
      if (url.pathname === '/api/debug/variables' && req.method === 'GET') {
        if (!debugManager) throw new HttpError(503, 'Debug manager is unavailable.');
        return sendJson(res, 200, { variables: await debugManager.variables(requiredQuery(url, 'sessionId'), url.searchParams.get('ref')) });
      }

      throw new HttpError(404, 'Route not found.');
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : error?.code === 'ENOENT' ? 404 : error?.code === 'EACCES' ? 403 : 500;
      sendJson(res, status, { error: { message: error instanceof Error ? error.message : 'Standalone host failure.' } });
    }
  }

  function close() {
    for (const watcher of watchers) watcher.close();
    watchers.clear();
    lspManager?.close();
    debugManager?.close();
    agentStore.close();
    repositoryContext.close();
    mcpManager.close();
  }

  return { handle, close, setWorkspaceRoot: applyWorkspaceRoot, get workspaceRoot() { return boundary.root; } };
}

class WorkspaceBoundary {
  root = '';

  async setRoot(value) {
    if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'Workspace root is required.');
    const resolved = await resolvePathWithMissingParent(resolve(value));
    if (!(await stat(resolved)).isDirectory()) throw new HttpError(400, 'Workspace root must be a directory.');
    this.root = resolved;
  }

  containsLexically(path) {
    return path === this.root || path.startsWith(`${this.root}${sep}`);
  }

  candidate(value) {
    if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'A filesystem path is required.');
    const target = resolve(isAbsolute(value) ? value : resolve(this.root, value));
    const resolved = resolvePathWithMissingParentSync(target);
    if (!this.containsLexically(resolved)) throw new HttpError(403, 'Path escapes the approved workspace root.');
    return resolved;
  }

  async existing(value) {
    const candidate = this.candidate(value);
    if (!(await isDirectoryOrFile(candidate))) throw new HttpError(404, `Path not found: ${candidate}`);
    return candidate;
  }

  async writable(value) {
    const candidate = this.candidate(value);
    const parent = resolvePathWithMissingParentSync(dirname(candidate));
    if (!this.containsLexically(parent)) throw new HttpError(403, 'Write target escapes the approved workspace root.');
    return candidate;
  }

  async writableTree(value) {
    const candidate = this.candidate(value);
      let ancestor = dirname(candidate);
      while (this.containsLexically(ancestor)) {
        try {
          const resolved = resolvePathWithMissingParentSync(ancestor);
          if (!this.containsLexically(resolved)) throw new HttpError(403, 'Write target escapes the approved workspace root.');
          return candidate;
        } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        if (ancestor === this.root) break;
        ancestor = dirname(ancestor);
      }
    }
    throw new HttpError(403, 'Write target has no approved workspace ancestor.');
  }
}

async function handleGit(req, res, url, boundary) {
  const operation = url.pathname.slice('/api/git/'.length);
  const readRepo = async (body) => boundary.existing(body?.repoPath || url.searchParams.get('path'));
  if (req.method === 'GET' && operation === 'status') {
    const repo = await readRepo();
    const { stdout } = await git(repo, ['status', '--porcelain=v1', '--branch', '--untracked-files=all']);
    const status = await parseGitStatus(repo, stdout);
    return sendJson(res, 200, status);
  }
  if (req.method === 'GET' && operation === 'diff') {
    const repo = await readRepo();
    const file = url.searchParams.get('file');
    const args = ['diff', '--no-ext-diff'];
    if (file) { await validateRepoFiles(boundary, repo, [file]); args.push('--', file); }
    const { stdout } = await git(repo, args, { allowExitOne: true });
    return sendJson(res, 200, { diff: stdout });
  }
  if (req.method === 'GET' && operation === 'log') {
    const repo = await readRepo();
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
    const { stdout } = await git(repo, ['log', `-${limit}`, '--format=%H%x1f%s%x1f%an%x1f%aI']);
    const commits = stdout.trim() ? stdout.trim().split('\n').map((line) => {
      const [sha, subject, author, date] = line.split('\x1f');
      return { sha, subject, author, date };
    }) : [];
    return sendJson(res, 200, { commits });
  }
  if (req.method === 'GET' && operation === 'branches') {
    const repo = await readRepo();
    const { stdout } = await git(repo, ['for-each-ref', '--format=%(refname:short)%09%(HEAD)%09%(upstream:short)', 'refs/heads/']);
    const branches = stdout.trim() ? stdout.trim().split('\n').map((line) => {
      const [name, head, remote] = line.split('\t');
      return { name, current: head === '*', ...(remote ? { remote } : {}) };
    }) : [];
    return sendJson(res, 200, { branches });
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const body = await readJson(req);
  const repo = await readRepo(body);
  if (operation === 'stage' || operation === 'unstage') {
    const files = await validateRepoFiles(boundary, repo, body.files);
    await git(repo, operation === 'stage' ? ['add', '--', ...files] : ['reset', 'HEAD', '--', ...files]);
  } else if (operation === 'commit') {
    await assertProoflineAllowsRawGit(repo, operation);
    if (typeof body.message !== 'string' || !body.message.trim()) throw new HttpError(400, 'Commit message is required.');
    await git(repo, ['commit', '-m', body.message.trim()]);
  } else if (operation === 'fetch') await git(repo, ['fetch', '--all', '--prune']);
  else if (operation === 'pull') await git(repo, ['pull', '--ff-only']);
  else if (operation === 'push') {
    await assertProoflineAllowsRawGit(repo, operation);
    await git(repo, ['push']);
  }
  else if (operation === 'branch') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(body.name || '') || String(body.name).includes('..')) throw new HttpError(400, 'Invalid branch name.');
    await git(repo, ['branch', body.name]);
  } else if (operation === 'checkout') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(body.branch || '') || String(body.branch).includes('..')) throw new HttpError(400, 'Invalid branch name.');
    await git(repo, ['switch', body.branch]);
  } else throw new HttpError(404, 'Git operation not found.');
  return sendJson(res, 200, { ok: true });
}

async function parseGitStatus(repo, output) {
  const lines = output.split('\n').filter(Boolean);
  const branchLine = lines[0]?.startsWith('## ') ? lines.shift().slice(3) : '';
  const branchMatch = branchLine.match(/^([^.]\S*|HEAD)(?:\.\.\.([^ ]+))?(?: \[(.*)\])?$/);
  const branch = branchMatch?.[1] === 'HEAD' ? null : branchMatch?.[1] || null;
  const upstream = branchMatch?.[2] || null;
  const counts = branchMatch?.[3] || '';
  const ahead = Number(counts.match(/ahead (\d+)/)?.[1] || 0);
  const behind = Number(counts.match(/behind (\d+)/)?.[1] || 0);
  const changedFiles = lines.map((line) => {
    const x = line[0]; const y = line[1];
    const rawPath = line.slice(3);
    const path = rawPath.includes(' -> ') ? rawPath.split(' -> ').at(-1) : rawPath;
    const pair = `${x}${y}`;
    const status = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(pair) ? 'conflicted'
      : pair === '??' ? 'untracked'
        : pair.includes('R') ? 'renamed'
          : pair.includes('A') ? 'added'
            : pair.includes('D') ? 'deleted' : 'modified';
    return { path, status, staged: x !== ' ' && x !== '?' };
  });
  let lastCommit = null;
  try {
    const { stdout } = await git(repo, ['log', '-1', '--format=%H%x1f%s%x1f%an%x1f%aI']);
    if (stdout.trim()) {
      const [sha, subject, author, date] = stdout.trim().split('\x1f');
      lastCommit = { sha, subject, author, date };
    }
  } catch { /* an unborn repository has no last commit */ }
  return {
    repoPath: repo,
    branch,
    upstream,
    ahead,
    behind,
    clean: changedFiles.length === 0,
    changedFiles,
    lastCommit,
    prooflineGoverned: await isProoflineGoverned(repo),
  };
}

async function assertProoflineAllowsRawGit(repo, operation) {
  if (!await isProoflineGoverned(repo)) return;
  throw new HttpError(
    403,
    `Proofline governs this repository. CURSEM will not run raw git ${operation}; use the approved Proofline session-end flow after its required gates and authorization.`,
  );
}

async function isProoflineGoverned(repo) {
  try {
    const { stdout } = await git(repo, ['rev-parse', '--show-toplevel']);
    const metadata = await stat(join(stdout.trim(), '.proofline.json'));
    return metadata.isFile();
  } catch (error) {
    if (error?.status === 400 || error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function validateRepoFiles(boundary, repo, files) {
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== 'string' || !file.trim())) {
    throw new HttpError(400, 'A non-empty files array is required.');
  }
  for (const file of files) {
    const candidate = resolve(repo, file);
    if (!boundary.containsLexically(candidate) || relative(repo, candidate).startsWith(`..${sep}`)) throw new HttpError(403, 'Git file escapes the repository.');
  }
  return files;
}

async function git(cwd, args, options = {}) {
  try {
    return await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: GIT_TIMEOUT_MS });
  } catch (error) {
    if (options.allowExitOne && error?.code === 1) return { stdout: error.stdout || '', stderr: error.stderr || '' };
    throw new HttpError(400, String(error?.stderr || error?.message || 'Git command failed.').trim());
  }
}

async function describeWorkspace(root) {
  const project = { id: workspaceId(root), name: basename(root) || root };
  const repositories = [];
  try {
    const { stdout: repoRoot } = await git(root, ['rev-parse', '--show-toplevel']);
    const path = repoRoot.trim();
    const { stdout: branchOut } = await git(path, ['branch', '--show-current']);
    const { stdout: gitDir } = await git(path, ['rev-parse', '--git-dir']);
    repositories.push({ id: workspaceId(path), path, branch: branchOut.trim(), isWorktree: resolve(path, gitDir.trim()) !== resolve(path, '.git') });
  } catch { /* non-Git folders are valid workspaces */ }
  return { id: project.id, root, project, repositories };
}

function workspaceId(root) {
  return `local-${Buffer.from(root).toString('base64url').slice(0, 32)}`;
}

const BINARY_MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.zip': 'application/zip', '.gz': 'application/gzip',
};

function binaryMimeFor(path) {
  return BINARY_MIME_BY_EXT[extname(path).toLowerCase()] || 'application/octet-stream';
}

async function isDirectoryOrFile(value) {
  try {
    const file = await stat(value);
    return file.isDirectory() || file.isFile();
  } catch {
    return false;
  }
}

function resolvePathWithMissingParentSync(candidate) {
  let unresolved = candidate;
  let suffix = '';
  while (true) {
    try {
      const resolved = realpathSync(unresolved);
      return `${resolved}${suffix}`;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(unresolved);
      if (parent === unresolved) return candidate;
      suffix = `${unresolved.slice(parent.length)}${suffix}`;
      unresolved = parent;
    }
  }
}

async function resolvePathWithMissingParent(value) {
  let unresolved = resolve(value);
  let suffix = '';
  while (true) {
    try {
      const resolved = await realpath(unresolved);
      return `${resolved}${suffix}`;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(unresolved);
      if (parent === unresolved) return value;
      suffix = `${unresolved.slice(parent.length)}${suffix}`;
      unresolved = parent;
    }
  }
}

async function chooseWorkspaceMacOS(currentRoot) {
  if (process.platform !== 'darwin') throw new HttpError(501, 'Native folder selection is currently available on macOS only.');
  const script = `POSIX path of (choose folder with prompt "Open a folder in CURSEM IDE" default location POSIX file ${JSON.stringify(currentRoot)})`;
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 120_000 });
    return stdout.trim().replace(/\/$/, '');
  } catch (error) {
    if (error?.code === 1 && /User canceled/i.test(error.stderr || '')) return null;
    throw error;
  }
}

function languageServers() {
  return [
    ['typescript', 'TypeScript Language Server'], ['javascript', 'TypeScript Language Server'],
    ['json', 'Monaco JSON'], ['html', 'Monaco HTML'], ['css', 'Monaco CSS'],
    ['markdown', 'Markdown'], ['python', 'Pyright'], ['shell', 'Bash Language Server'], ['rust', 'rust-analyzer'],
  ].map(([languageId, name]) => ({ languageId, name }));
}

function requiredQuery(url, name) {
  const value = url.searchParams.get(name);
  if (!value) throw new HttpError(400, `${name} query parameter is required.`);
  return value;
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, `Body exceeds ${MAX_BODY_BYTES} bytes.`);
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new HttpError(400, 'Request body must be valid JSON.'); }
}

function sendJson(res, status, payload) {
  if (res.headersSent || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
    connection: 'close',
  });
  res.end(body);
}
