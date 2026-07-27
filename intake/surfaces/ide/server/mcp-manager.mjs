import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

const REQUEST_TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = '2025-06-18';

/** MCP manager with explicit activation and redacted configuration exposure. */
export function createMcpManager({ workspaceRoot }) {
  let root = workspaceRoot;
  const sessions = new Map();

  async function configurations() {
    const sources = [
      { path: resolve(homedir(), '.cursem', 'mcp.json'), scope: 'user' },
      { path: resolve(root, '.cursor', 'mcp.json'), scope: 'cursor-project' },
      { path: resolve(root, '.cursem', 'mcp.json'), scope: 'project' },
    ];
    const merged = new Map();
    for (const source of sources) {
      try {
        const parsed = JSON.parse(await readFile(source.path, 'utf8'));
        for (const [id, raw] of Object.entries(parsed?.mcpServers || {})) merged.set(id, normalizeConfig(id, raw, source));
      } catch (error) {
        if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
    }
    return merged;
  }

  async function list() {
    const configs = await configurations();
    return Array.from(configs.values()).map((config) => ({
      id: config.id, scope: config.scope, transport: config.transport, source: config.source,
      command: config.command, args: config.args, url: config.url, envKeys: Object.keys(config.env || {}),
      status: sessions.has(config.id) ? 'connected' : 'disconnected',
    }));
  }

  async function connect(id) {
    if (sessions.has(id)) return sessions.get(id).info();
    const config = (await configurations()).get(id);
    if (!config) throw httpError(404, `MCP server not configured: ${id}`);
    const session = config.transport === 'stdio' ? createStdioSession(config, root) : createHttpSession(config);
    try { await session.initialize(); sessions.set(id, session); return session.info(); }
    catch (error) { session.close(); throw error; }
  }

  async function tools(id) {
    const session = sessions.get(id); if (!session) throw httpError(409, `MCP server is not connected: ${id}`);
    const result = await session.request('tools/list', {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async function call(id, name, args) {
    const session = sessions.get(id); if (!session) throw httpError(409, `MCP server is not connected: ${id}`);
    if (typeof name !== 'string' || !name.trim()) throw httpError(400, 'MCP tool name is required.');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw httpError(400, 'MCP tool arguments must be an object.');
    return session.request('tools/call', { name, arguments: args });
  }

  return {
    list,
    connect,
    tools,
    call,
    disconnect(id) { const session = sessions.get(id); if (!session) return false; session.close(); sessions.delete(id); return true; },
    async setWorkspaceRoot(nextRoot) { for (const session of sessions.values()) session.close(); sessions.clear(); root = nextRoot; },
    close() { for (const session of sessions.values()) session.close(); sessions.clear(); },
  };
}

function createStdioSession(config, workspaceRoot) {
  let child = null; let nextId = 1; let buffer = Buffer.alloc(0); const pending = new Map();
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const handle = (message) => {
    if (message.id === undefined || !pending.has(message.id)) return;
    const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message || 'MCP request failed.')); else entry.resolve(message.result);
  };
  const decode = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd >= 0 && /^Content-Length:/i.test(buffer.subarray(0, headerEnd).toString('utf8'))) {
        const length = Number(buffer.subarray(0, headerEnd).toString('utf8').match(/Content-Length:\s*(\d+)/i)?.[1]);
        if (buffer.length < headerEnd + 4 + length) return;
        const raw = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8'); buffer = buffer.subarray(headerEnd + 4 + length);
        try { handle(JSON.parse(raw)); } catch {}
        continue;
      }
      const newline = buffer.indexOf('\n'); if (newline < 0) return;
      const raw = buffer.subarray(0, newline).toString('utf8').trim(); buffer = buffer.subarray(newline + 1);
      if (raw) try { handle(JSON.parse(raw)); } catch {}
    }
  };
  const rejectAll = (message) => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)); } pending.clear(); };

  return {
    async initialize() {
      child = spawn(config.command, config.args, { cwd: workspaceRoot, env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      child.stdout.on('data', decode); child.once('exit', (code, signal) => rejectAll(`MCP server exited (${code ?? signal}).`)); child.once('error', (error) => rejectAll(error.message));
      await new Promise((resolvePromise, reject) => { child.once('spawn', resolvePromise); child.once('error', reject); });
      await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'CURSEM', version: '1.0.0' } });
      send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    },
    request(method, params) {
      if (!child || child.exitCode !== null) return Promise.reject(new Error('MCP server is not running.'));
      const id = nextId++;
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP request timed out: ${method}`)); }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve: resolvePromise, reject, timer });
        send({ jsonrpc: '2.0', id, method, params });
      });
    },
    info() { return { id: config.id, status: child?.exitCode === null ? 'connected' : 'disconnected', transport: 'stdio', pid: child?.pid }; },
    close() { rejectAll('MCP server disconnected.'); child?.kill('SIGTERM'); child = null; },
  };
}

function createHttpSession(config) {
  let sessionId = null; let initialized = false;
  const request = async (method, params) => {
    const id = crypto.randomUUID();
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(config.url, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sessionId ? { 'mcp-session-id': sessionId } : {}), ...config.headers },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${await response.text()}`);
      sessionId = response.headers.get('mcp-session-id') || sessionId;
      const raw = await response.text(); const payload = parseHttpPayload(raw, response.headers.get('content-type') || '');
      if (payload.error) throw new Error(payload.error.message || 'MCP request failed.');
      return payload.result;
    } finally { clearTimeout(timer); }
  };
  return {
    async initialize() { await request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'CURSEM', version: '1.0.0' } }); initialized = true; },
    request,
    info() { return { id: config.id, status: initialized ? 'connected' : 'disconnected', transport: 'http' }; },
    close() { initialized = false; sessionId = null; },
  };
}

function normalizeConfig(id, raw, source) {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(id)) throw httpError(400, `Invalid MCP server id: ${id}`);
  if (!raw || typeof raw !== 'object') throw httpError(400, `Invalid MCP configuration: ${id}`);
  if (raw.command) {
    if (typeof raw.command !== 'string' || raw.command.includes('\0')) throw httpError(400, `Invalid MCP command: ${id}`);
    const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
    const env = Object.fromEntries(Object.entries(raw.env || {}).map(([key, value]) => [key, String(value)]));
    return { id, scope: source.scope, source: source.path, transport: 'stdio', command: raw.command, args, env };
  }
  if (raw.url) {
    const url = new URL(raw.url);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname))) throw httpError(400, `MCP HTTP URL must use HTTPS or loopback HTTP: ${id}`);
    const headers = Object.fromEntries(Object.entries(raw.headers || {}).map(([key, value]) => [key, String(value)]));
    return { id, scope: source.scope, source: source.path, transport: 'http', url: url.toString(), headers };
  }
  throw httpError(400, `MCP server requires command or url: ${id}`);
}

function parseHttpPayload(raw, contentType) {
  if (!contentType.includes('text/event-stream')) return JSON.parse(raw);
  const data = raw.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).at(-1);
  if (!data) throw new Error('MCP server returned an empty event stream.');
  return JSON.parse(data);
}
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
