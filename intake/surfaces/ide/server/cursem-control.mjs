// === CURSEM IDE — in-shell control plane (`cursem` CLI backend) ============
//
// Rides the existing loopback listener (127.0.0.1:CURSEM_PORT) — no new port.
//
//   POST /api/control/invoke    bearer-checked {method, args} → {result}|{error}
//   GET  /api/control/settings  bearer-checked permission matrix + current values
//   PUT  /api/control/settings  bearer-checked partial update, persisted to disk
//   WS   /api/control/ws        renderer executor channel (same-origin upgrade)
//
// Security posture (mirrors the Cate control surface):
//   - The bearer token is minted per server run (randomBytes(32).base64url),
//     never persisted, and NEVER exposed via any GET route. It reaches the
//     renderer exactly once — as the first message of the same-origin control
//     WebSocket handshake — and reaches shells via CURSEM_TOKEN env injection.
//   - Every invoke passes the SERVER-side permission gate (cursem-permissions
//     .mjs) before any state is touched; denied calls return a stable error
//     code naming the exact Settings toggle to flip.
//
// Deviation from the Cate feature map (documented in the Phase 2B report):
//   - Settings routes live HERE (/api/control/settings), not in standalone-
//     host.mjs, backed by ~/.cursem-ide/settings.json.
//   - editor.openFile path confinement re-implements the WorkspaceBoundary
//     candidate logic locally (standalone-host.mjs does not export it).

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import {
  CLI_PERMISSION_MATRIX,
  CONTROL_API_VERSION,
  DEFAULT_CLI_SETTINGS,
  SUPPORTED_METHODS,
  cliPermissionForMethod,
  mergeCliSettings,
} from './cursem-permissions.mjs';

const MAX_INVOKE_BODY_BYTES = 1024 * 1024; // 1 MiB, mirrors cateApiReverse.
const FORWARD_TIMEOUT_MS = 10_000; // mirrors Cate FORWARD_TIMEOUT_MS.
const CONTROL_WS_SUBPROTOCOL = 'cursem-control';

export function createControlPlane({ server, getWorkspaceRoot, settingsPath, forwardTimeoutMs = FORWARD_TIMEOUT_MS }) {
  const token = randomBytes(32).toString('base64url');
  const settingsFile = settingsPath || resolve(homedir(), '.cursem-ide', 'settings.json');
  let settings = loadSettings(settingsFile);

  // ─── Renderer executor channel ──────────────────────────────────────────
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(CONTROL_WS_SUBPROTOCOL) ? CONTROL_WS_SUBPROTOCOL : false),
  });
  let executorSocket = null;
  let nextRequestId = 1;
  const pending = new Map(); // requestId → { resolve, timer }

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname; } catch { socket.destroy(); return; }
    if (pathname !== '/api/control/ws') return; // other upgrade handlers own their paths
    // The renderer proves it is the same-origin UI: loopback peer AND an
    // Origin header matching this server's own loopback host:port. There is
    // intentionally no token in the subprotocol — the renderer cannot know it
    // yet; the handshake is where the token is DELIVERED to the renderer.
    const remote = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (remote !== '127.0.0.1' && remote !== '::1') return socket.destroy();
    if (!isSameOriginUpgrade(req)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => attachExecutor(ws));
  });

  function isSameOriginUpgrade(req) {
    const originHeader = req.headers.origin;
    if (typeof originHeader !== 'string' || !originHeader) return false;
    let origin;
    try { origin = new URL(originHeader); } catch { return false; }
    const loopbackHost = origin.hostname === '127.0.0.1' || origin.hostname === 'localhost' || origin.hostname === '[::1]';
    if (!loopbackHost) return false;
    return origin.host === String(req.headers.host || '');
  }

  function attachExecutor(ws) {
    if (executorSocket && executorSocket.readyState === executorSocket.OPEN) {
      // Latest renderer wins; reject its pending forwards before replacing.
      try { executorSocket.close(1000, 'superseded'); } catch { /* already closing */ }
    }
    executorSocket = ws;
    // Token delivery: exactly once, first frame, only ever over this
    // same-origin channel. The renderer uses it for CURSEM_TOKEN env injection
    // and the settings routes; it is never GETable.
    ws.send(JSON.stringify({ type: 'hello', token, api: `${loopbackHttpBase()}/api/control`, version: CONTROL_API_VERSION }));
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (typeof msg?.requestId !== 'number') return;
      const entry = pending.get(msg.requestId);
      if (!entry) return;
      pending.delete(msg.requestId);
      clearTimeout(entry.timer);
      entry.resolve(msg.ok === true
        ? { result: msg.result ?? null }
        : { error: normalizeExecutorError(msg.error) });
    });
    ws.on('close', () => { if (executorSocket === ws) executorSocket = null; });
    ws.on('error', () => { if (executorSocket === ws) executorSocket = null; });
  }

  function loopbackHttpBase() {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  function normalizeExecutorError(value) {
    if (value && typeof value === 'object' && typeof value.code === 'string') {
      return { code: value.code, message: typeof value.message === 'string' ? value.message : value.code };
    }
    return { code: 'executor-error', message: typeof value === 'string' ? value : 'The renderer executor failed.' };
  }

  function forwardToRenderer(method, args) {
    const ws = executorSocket;
    if (!ws || ws.readyState !== ws.OPEN) {
      return Promise.resolve({
        error: { code: 'executor-unavailable', message: 'No CURSEM IDE window is connected to the control channel. Open the IDE and retry.' },
      });
    }
    const requestId = nextRequestId++;
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolvePromise({ error: { code: 'executor-timeout', message: `The renderer did not answer ${method} within ${forwardTimeoutMs}ms.` } });
      }, forwardTimeoutMs);
      pending.set(requestId, { resolve: resolvePromise, timer });
      try {
        ws.send(JSON.stringify({ requestId, method, args: args ?? {} }));
      } catch (error) {
        pending.delete(requestId);
        clearTimeout(timer);
        resolvePromise({ error: { code: 'executor-error', message: error instanceof Error ? error.message : 'Control channel send failed.' } });
      }
    });
  }

  // ─── Dispatch core ──────────────────────────────────────────────────────

  async function dispatch(method, args) {
    if (!SUPPORTED_METHODS.has(method)) {
      return { error: { code: 'unsupported', message: `Unsupported control method: ${method}` } };
    }
    // Gate BEFORE any state is touched (Cate gate order: supported → master → cell).
    if (settings.cliEnabled !== true) {
      return { error: { code: 'cli-disabled', message: 'The in-shell CLI is disabled. Enable "In-shell CLI (cursem)" in Settings → CLI.' } };
    }
    const cell = cliPermissionForMethod(method);
    if (cell && settings[cell.key] !== true) {
      return {
        error: {
          code: 'permission-denied',
          setting: cell.key,
          message: `Denied by Settings → CLI → ${cell.label} (${cell.key}). Enable that toggle to allow ${method}.`,
        },
      };
    }
    if (method === 'cursem.version') return { result: { version: CONTROL_API_VERSION } };
    if (method === 'cursem.editor.openFile') {
      const confined = confineOpenFile(args);
      if (confined.error) return confined;
      args = confined.args;
    }
    return forwardToRenderer(method, args);
  }

  /** Workspace confinement for editor.openFile — mirrors WorkspaceBoundary
   *  .candidate/existing in standalone-host.mjs (which does not export it). */
  function confineOpenFile(args) {
    const root = typeof getWorkspaceRoot === 'function' ? getWorkspaceRoot() : '';
    const value = args?.path;
    if (typeof value !== 'string' || !value.trim()) {
      return { error: { code: 'path-required', message: 'editor.openFile requires a path.' } };
    }
    if (!root) return { error: { code: 'no-workspace', message: 'No workspace is open.' } };
    // Compare against the root's realpath too — macOS /var is a symlink to
    // /private/var, and realpathSync on the target would otherwise "escape".
    let realRoot;
    try { realRoot = realpathSync(root); } catch { realRoot = root; }
    const target = resolve(isAbsolute(value) ? value : resolve(realRoot, value));
    let resolved;
    try {
      resolved = realpathSync(target);
    } catch {
      return { error: { code: 'no-such-file', message: `Path not found: ${target}` } };
    }
    if (resolved !== realRoot && !resolved.startsWith(`${realRoot}${sep}`)) {
      return { error: { code: 'path-escapes-workspace', message: `Path escapes the approved workspace root: ${value}` } };
    }
    try {
      if (!statSync(resolved).isFile()) {
        return { error: { code: 'not-a-file', message: `Path is not a file: ${resolved}` } };
      }
    } catch {
      return { error: { code: 'no-such-file', message: `Path not found: ${resolved}` } };
    }
    const next = { ...(args || {}), path: resolved };
    if (next.line !== undefined) {
      const line = Math.floor(Number(next.line));
      if (!Number.isInteger(line) || line < 1) return { error: { code: 'bad-position', message: 'line must be a positive integer.' } };
      next.line = line;
      const column = Math.floor(Number(next.column ?? 1));
      if (!Number.isInteger(column) || column < 1) return { error: { code: 'bad-position', message: 'column must be a positive integer.' } };
      next.column = column;
    }
    return { args: next };
  }

  // ─── HTTP routes ────────────────────────────────────────────────────────

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/api/control/invoke' && req.method === 'POST') {
      if (!authorized(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } });
      let body;
      try {
        body = JSON.parse((await readBoundedBody(req, MAX_INVOKE_BODY_BYTES)).toString('utf8') || '{}');
      } catch (error) {
        const tooLarge = error instanceof Error && error.message.includes('Payload exceeds');
        return sendJson(res, tooLarge ? 413 : 400, { error: { code: tooLarge ? 'payload-too-large' : 'bad-request', message: 'Invalid invoke body.' } });
      }
      if (typeof body?.method !== 'string' || !body.method) {
        return sendJson(res, 400, { error: { code: 'bad-request', message: 'Body must be {"method": string, "args": object}.' } });
      }
      try {
        const outcome = await dispatch(body.method, body.args ?? {});
        return sendJson(res, 200, outcome.error ? outcome : { result: outcome.result ?? null });
      } catch (error) {
        return sendJson(res, 500, { error: { code: 'internal', message: error instanceof Error ? error.message : 'Control dispatch failed.' } });
      }
    }

    if (url.pathname === '/api/control/settings') {
      // Bearer-checked like invoke: these routes govern the gate itself.
      if (!authorized(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } });
      if (req.method === 'GET') {
        return sendJson(res, 200, { settings, matrix: CLI_PERMISSION_MATRIX, version: CONTROL_API_VERSION });
      }
      if (req.method === 'PUT') {
        let body;
        try {
          body = JSON.parse((await readBoundedBody(req, MAX_INVOKE_BODY_BYTES)).toString('utf8') || '{}');
        } catch {
          return sendJson(res, 400, { error: { code: 'bad-request', message: 'Invalid settings body.' } });
        }
        settings = mergeCliSettings(settings, body?.settings);
        try {
          await mkdir(dirname(settingsFile), { recursive: true });
          await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
        } catch (error) {
          return sendJson(res, 500, { error: { code: 'settings-persist-failed', message: error instanceof Error ? error.message : 'Could not persist settings.' } });
        }
        return sendJson(res, 200, { settings, matrix: CLI_PERMISSION_MATRIX, version: CONTROL_API_VERSION });
      }
      return sendJson(res, 405, { error: { code: 'method-not-allowed', message: 'Use GET or PUT.' } });
    }

    return sendJson(res, 404, { error: { code: 'not-found', message: `Unknown control route: ${url.pathname}` } });
  }

  function authorized(req) {
    const header = String(req.headers.authorization || '');
    return header === `Bearer ${token}`;
  }

  return {
    handle,
    dispatch,
    get token() { return token; },
    get settings() { return settings; },
    close() {
      for (const [requestId, entry] of pending) {
        clearTimeout(entry.timer);
        entry.resolve({ error: { code: 'executor-unavailable', message: 'Control plane is shutting down.' } });
        pending.delete(requestId);
      }
      if (executorSocket) { try { executorSocket.close(1001, 'shutdown'); } catch { /* closing */ } }
      wss.close();
    },
  };
}

function loadSettings(settingsFile) {
  try {
    if (!existsSync(settingsFile)) return { ...DEFAULT_CLI_SETTINGS };
    const parsed = JSON.parse(readFileSync(settingsFile, 'utf8'));
    return mergeCliSettings({ ...DEFAULT_CLI_SETTINGS }, parsed);
  } catch {
    return { ...DEFAULT_CLI_SETTINGS };
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBoundedBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.byteLength;
    if (total > limit) {
      req.destroy(new Error(`Payload exceeds ${limit} bytes.`));
      throw new Error(`Payload exceeds ${limit} bytes.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}
