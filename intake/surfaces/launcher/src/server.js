'use strict';

const express = require('express');
const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');

const WebSocket = require('ws');

// node-pty ships a native `spawn-helper` binary that it exec()s to allocate a
// PTY. Some restore/copy paths (e.g. cloning node_modules across volumes)
// drop its execute bit, after which every pty.spawn fails with
// "posix_spawnp failed." Re-assert +x before requiring node-pty so the
// launcher self-heals instead of returning SPAWN_FAILED on every launch.
(function ensurePtyHelperExecutable() {
  try {
    const base = path.join(path.dirname(require.resolve('node-pty')), '..', 'prebuilds');
    for (const p of [
      path.join(base, `${process.platform}-${process.arch}`, 'spawn-helper'),
      path.join(path.dirname(require.resolve('node-pty')), '..', 'build', 'Release', 'spawn-helper'),
    ]) {
      try {
        fs.accessSync(p, fs.constants.X_OK);
      } catch {
        try { fs.chmodSync(p, 0o755); } catch { /* best effort */ }
      }
    }
  } catch { /* node-pty layout differs; pty.spawn will surface any real error */ }
})();

const pty = require('node-pty');
const crypto = require('crypto');

const {
  HARNESSES,
  VALID_HARNESS_NAMES,
  HARNESS_BY_NAME
} = require('./harnesses');

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Session
 * @property {string} id - UUID identifier
 * @property {string|null} harnessName - Name of launched harness, null for bare shell
 * @property {string|null} command - Resolved shell command
 * @property {import('node-pty').IPty|undefined} ptyProcess - Live PTY process
 * @property {boolean} sessionActive - False after WS close/error
 * @property {boolean} processExited - True after PTY exit event fires
 * @property {boolean} clientClosing - True when client sent {type:'close'} — emit 'exit' not 'shell-reset'
 * @property {import('ws').WebSocket} ws - WebSocket connection
 * @property {number} startedAt - Date.now() at creation
 * @property {string} [shellCwd] - Working directory for respawn
 * @property {string[]} [args] - Launch args
 * @property {string} [cwd] - Original launch cwd
 * @property {number} [lastCols] - Last known terminal width
 * @property {number} [lastRows] - Last known terminal height
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 11000;
const HOST = process.env.HOST || '127.0.0.1'; // CR-002: bind localhost by default, not all interfaces
const MAX_CONCURRENT_SESSIONS = 10;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 1_000;
const MAX_COLS = 500;
const MAX_ROWS = 200;
const SHELL_FALLBACK = '/bin/zsh'; // CR-005: single fallback for spawnShell + launchHarness
const HARNESS_EXIT_PREFIX = '\x1eFLOYD_HARNESS_EXIT:';
const HARNESS_EXIT_SUFFIX = '\x1f';

// ─── In-memory state ──────────────────────────────────────────────────────────

/** @type {Map<string, Session>} */
const activeSessions = new Map();

/** @type {Map<string, NodeJS.Timeout>} */
const pingTimers = new Map();

/** @type {Map<string, NodeJS.Timeout>} */
const pongTimers = new Map();

// ─── Structured logger ───────────────────────────────────────────────────────

/** @param {'info'|'warn'|'error'} level */
function log(level, sessionId, msg, meta = {}) {
  const entry = { ts: new Date().toISOString(), level, sessionId: sessionId || null, msg, ...meta };
  if (level === 'error') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

const info = (id, msg, m) => log('info', id, msg, m);
const warn = (id, msg, m) => log('warn', id, msg, m);
const error = (id, msg, m) => log('error', id, msg, m);

// ─── Input validation ────────────────────────────────────────────────────────

/** @returns {{ cols: number, rows: number }} */
function clampDims(cols, rows) {
  return {
    cols: Math.max(1, Math.min(Math.floor(Number(cols)) || 120, MAX_COLS)),
    rows: Math.max(1, Math.min(Math.floor(Number(rows)) || 40, MAX_ROWS))
  };
}

/** @param {import('ws').WebSocket} ws @param {string} code @param {string} message @param {string|null} id */
function wsError(ws, code, message, id) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: 'error', code, message })); }
    catch (e) { error(id, 'WS send error failed', { code, err: e.message }); }
  }
}

// ─── PTY helpers ────────────────────────────────────────────────────────────

/** @param {import('node-pty').IPty|undefined} ptyProcess @param {string} id */
function killPty(ptyProcess, id) {
  if (!ptyProcess || typeof ptyProcess.kill !== 'function') return;
  try { ptyProcess.kill('SIGTERM'); }
  catch (e) { warn(id, 'SIGTERM failed — already dead', { err: e.message }); return; }
  // CR-009: unref so this timer doesn't keep the event loop alive during shutdown
  const timer = setTimeout(() => {
    try { if (ptyProcess && typeof ptyProcess.kill === 'function') ptyProcess.kill('SIGKILL'); }
    catch (_) {}
  }, KILL_GRACE_MS);
  timer.unref();
  if (typeof ptyProcess.once === 'function') ptyProcess.once('exit', () => clearTimeout(timer));
}

// ─── Session lifecycle ───────────────────────────────────────────────────────

function cleanupSession(session) {
  const { id, ptyProcess } = session;
  info(id, 'Cleaning up session');

  const pt = pingTimers.get(id);  if (pt) { clearInterval(pt); pingTimers.delete(id); }
  const po = pongTimers.get(id);  if (po) { clearTimeout(po); pongTimers.delete(id); }

  if (ptyProcess) { killPty(ptyProcess, id); session.ptyProcess = undefined; }
  activeSessions.delete(id);
  info(id, 'Session cleaned up');
}

/** @param {Session} session */
function startHeartbeat(session) {
  const { id } = session;
  const t = setInterval(() => {
    const s = activeSessions.get(id);
    if (!s || !s.ws || s.ws.readyState !== WebSocket.OPEN) { clearInterval(t); pingTimers.delete(id); return; }
    try { s.ws.ping(); }
    catch (_) { clearInterval(t); return; }
    const po = setTimeout(() => {
      warn(id, 'Pong missed — closing stale session');
      if (s.ws) s.ws.terminate();
    }, PONG_TIMEOUT_MS);
    pongTimers.set(id, po);
  }, PING_INTERVAL_MS);
  pingTimers.set(id, t);
}

// ─── Harness registry helpers ────────────────────────────────────────────────

/** @returns {{ resolved: string, error: null } | { resolved: null, error: string }} */
function resolveHarness(harnessName) {
  const h = HARNESS_BY_NAME[harnessName];
  if (!h) return { resolved: null, error: `Unknown harness: ${harnessName}` };
  return { resolved: h.command || harnessName, error: null };
}

// ─── PTY event wiring ──────────────────────────────────────────────────────

/**
 * Attach PTY data/exit/error handlers to a session + WebSocket.
 * Extracted to keep launchHarness under 50 lines.
 * @param {import('node-pty').IPty} ptyProcess
 * @param {Session} session
 * @param {import('ws').WebSocket} ws
 */
function wirePtyToSession(ptyProcess, session, ws) {
  const { id } = session;

  ptyProcess.onData((data) => {
    forwardPtyData(session, ws, data);
  });

  ptyProcess.once('exit', (code) => {
    if (session.processExited) return;
    session.processExited = true;
    // Client-initiated close: emit definitive 'exit' and tear down (no respawn).
    if (session.clientClosing) {
      info(id, 'Shell exited (client close)', { code });
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'exit', code: code || 0 })); }
        catch (_) {}
      }
      cleanupSession(session);
      return;
    }
    // Shell self-exit: notify client and respawn a live shell (UI feature).
    info(id, 'Shell exited, respawning', { code });
    if (ws.readyState === WebSocket.OPEN && session.sessionActive) {
      try { ws.send(JSON.stringify({ type: 'shell-reset', code: code || 0 })); }
      catch (_) {}
      // CR-006: check clientClosing to prevent respawn if client closed during the 50ms window
      setTimeout(() => {
        if (session.sessionActive && !session.clientClosing && ws.readyState === WebSocket.OPEN) {
          spawnShell(session, ws, session.shellCwd);
        } else {
          cleanupSession(session);
        }
      }, 50);
    } else {
      cleanupSession(session);
    }
  });

  ptyProcess.on('error', (err) => {
    error(id, 'PTY error', { err: err.message || String(err) });
    wsError(ws, 'PROCESS_ERROR', `Process error: ${err.message || String(err)}`, id);
    cleanupSession(session);
  });
}

function sendPtyMessage(session, ws, message) {
  if (!session.sessionActive || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(message)); }
  catch (e) { error(session.id, 'WS send failed', { type: message.type, err: e.message }); }
}

/**
 * Strip the shell wrapper's invisible lifecycle marker while forwarding PTY
 * output immediately. A short partial-prefix buffer handles markers split
 * across native PTY chunks without delaying normal terminal output.
 */
function forwardPtyData(session, ws, data) {
  let buffer = `${session.protocolBuffer || ''}${data}`;
  session.protocolBuffer = '';

  while (buffer) {
    const start = buffer.indexOf(HARNESS_EXIT_PREFIX);
    if (start < 0) {
      let held = 0;
      const max = Math.min(HARNESS_EXIT_PREFIX.length - 1, buffer.length);
      for (let size = 1; size <= max; size++) {
        if (HARNESS_EXIT_PREFIX.startsWith(buffer.slice(-size))) held = size;
      }
      const output = held ? buffer.slice(0, -held) : buffer;
      if (output) sendPtyMessage(session, ws, { type: 'output', data: output });
      session.protocolBuffer = held ? buffer.slice(-held) : '';
      return;
    }

    const before = buffer.slice(0, start);
    if (before) sendPtyMessage(session, ws, { type: 'output', data: before });
    const end = buffer.indexOf(HARNESS_EXIT_SUFFIX, start + HARNESS_EXIT_PREFIX.length);
    if (end < 0) {
      session.protocolBuffer = buffer.slice(start);
      return;
    }

    const rawCode = buffer.slice(start + HARNESS_EXIT_PREFIX.length, end);
    const code = Number.parseInt(rawCode, 10);
    sendPtyMessage(session, ws, {
      type: 'command-exit',
      harness: session.harnessName,
      code: Number.isFinite(code) ? code : 1,
    });
    buffer = buffer.slice(end + HARNESS_EXIT_SUFFIX.length);
  }
}

// ─── Shell spawn helper ─────────────────────────────────────────────────────

/**
 * Resolve PTY spawn configuration (workingDir, env, shell) shared by spawnShell
 * and launchHarness. Eliminates DRY violation where both functions duplicated
 * the same workingDir/ptyEnv/shell resolution logic.
 * @param {string} [cwd] - Requested working directory
 * @param {Object} [env] - Additional env vars to merge into ptyEnv
 * @returns {{ workingDir: string, ptyEnv: Object, shell: string }}
 */
function resolvePtyConfig(cwd, env = {}) {
  let workingDir = cwd || process.env.HOME || os.homedir();
  if (!fs.existsSync(workingDir)) workingDir = os.homedir();
  const requested = { ...process.env, TERM: 'xterm-256color', ...env };
  const protectedEnvironment = (name) => {
    const normalized = String(name).toUpperCase();
    return /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|CREDENTIALS?|PASSWORD|PASS|PASSWD|COOKIE|AUTHORIZATION|PAT)(?:_|$)/.test(normalized)
      || /(?:_BASE_URL|_ENDPOINT|_API_URL)$/.test(normalized)
      || normalized.startsWith('FLOYD_VAULT_')
      || normalized.startsWith('CURSEM_CREDENTIAL_PROXY_')
      || normalized.startsWith('OMP_AUTH_BROKER_')
      || ['AWS_ACCESS_KEY_ID', 'GOOGLE_APPLICATION_CREDENTIALS', 'AZURE_CLIENT_SECRET', 'FAL_KEY'].includes(normalized);
  };
  for (const name of Object.keys(requested)) {
    if (protectedEnvironment(name)) delete requested[name];
  }
  const ptyEnv = requested;
  const shell = process.env.SHELL || SHELL_FALLBACK;
  return { workingDir, ptyEnv, shell };
}

/**
 * Spawn a bare shell (ZSH) into the session and wire it up. Used both for
 * the harness launch wrapper and for respawning a live shell after exit so
 * the terminal never dies.
 * @param {Session} session
 * @param {import('ws').WebSocket} ws
 * @param {string} cwd
 */
function spawnShell(session, ws, cwd) {
  const { id } = session;
  const cols = session.lastCols || 120;
  const rows = session.lastRows || 40;

  const { workingDir, ptyEnv, shell } = resolvePtyConfig(cwd);

  session.shellCwd = workingDir;

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols, rows, cwd: workingDir, env: ptyEnv });
  } catch (e) {
    error(id, 'shell spawn failed', { err: e.message });
    return;
  }

  session.ptyProcess = ptyProcess;
  session.processExited = false;
  session.protocolBuffer = '';
  session.startedAt = Date.now();
  activeSessions.set(id, session);
  wirePtyToSession(ptyProcess, session, ws);
}

/**
 * @param {Session} session
 * @param {import('ws').WebSocket} ws
 * @param {string} harnessName
 * @param {{ cols?, rows?, args?, env?, cwd? }} config
 */
function launchHarness(session, ws, harnessName, config = {}) {
  const { id } = session;
  const { cols: rawCols, rows: rawRows, args = [], env = {}, cwd } = config;
  const { cols, rows } = clampDims(rawCols, rawRows);

  const { resolved, error: err } = resolveHarness(harnessName);
  if (err) { wsError(ws, 'INVALID_HARNESS', err, id); return; }

  if (activeSessions.size >= MAX_CONCURRENT_SESSIONS) {
    wsError(ws, 'SESSION_LIMIT', `Server at capacity (${MAX_CONCURRENT_SESSIONS} active sessions). Close a session and retry.`, id);
    return;
  }

  const { workingDir, ptyEnv, shell } = resolvePtyConfig(cwd, env);
  // CR-004: shell-escape each arg to prevent command injection via metacharacters
  const escapedArgs = args.map((a) => `'${String(a).replace(/'/g, `'"'"'`)}'`);
  const command = resolved + (escapedArgs.length ? ' ' + escapedArgs.join(' ') : '');

  /** @type {import('node-pty').IPty|undefined} */
  let ptyProcess;
  try { ptyProcess = pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols, rows, cwd: workingDir, env: ptyEnv }); }
  catch (e) { error(id, 'pty.spawn failed', { err: e.message }); wsError(ws, 'SPAWN_FAILED', `Could not create terminal: ${e.message}`, id); return; }

  // Populate session
  session.harnessName = harnessName;
  session.command = resolved;
  session.args = args;
  session.cwd = workingDir;
  session.lastCols = cols;
  session.lastRows = rows;
  session.shellCwd = workingDir;
  session.ptyProcess = ptyProcess;
  session.processExited = false;
  session.startedAt = Date.now();
  activeSessions.set(id, session);
  info(id, 'Harness launched', { harness: harnessName, command, cols, rows, cwd: workingDir });
  ws.send(JSON.stringify({ type: 'launched', harness: harnessName, sessionId: id, command, cwd: workingDir }));

  wirePtyToSession(ptyProcess, session, ws);

  const lifecycle = `; __floyd_harness_code=$?; printf '\\036FLOYD_HARNESS_EXIT:%s\\037' "$__floyd_harness_code"`;
  try { ptyProcess.write(command + lifecycle + '\r'); }
  catch (e) { error(id, 'Failed to write launch command', { err: e.message }); wsError(ws, 'WRITE_FAILED', `Could not send input: ${e.message}`, id); }
}

// ─── Message dispatcher ─────────────────────────────────────────────────────

/** @param {Session} session @param {import('ws').WebSocket} ws @param {object} data */
function handleMessage(session, ws, data) {
  if (!session.sessionActive) return;

  switch (data.type) {
    case 'shell': {
      // Bare ZSH shell — no harness command. Frontend requests this on load
      // so the terminal is the default home screen.
      if (session.ptyProcess && !session.processExited) {
        try { session.ptyProcess.kill(); } catch (_) {}
      }
      // CR-012: single clampDims call (was redundantly called twice with swapped args)
      const shellDims = clampDims(data.cols, data.rows);
      session.lastCols = shellDims.cols;
      session.lastRows = shellDims.rows;
      spawnShell(session, ws, data.cwd || process.env.HOME || os.homedir());
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'launched', harness: 'shell', sessionId: session.id, command: process.env.SHELL || '/bin/zsh', cwd: session.shellCwd }));
      }
      break;
    }
    case 'launch': {
      const { harness, cols, rows, args, env, cwd } = data;
      if (!harness) { wsError(ws, 'MISSING_HARNESS', 'launch message must include {harness}', session.id); return; }
      if (!VALID_HARNESS_NAMES.includes(harness)) { wsError(ws, 'INVALID_HARNESS', `Unknown harness: ${harness}`, session.id); return; }
      launchHarness(session, ws, harness, { cols, rows, args, env, cwd });
      break;
    }
    case 'input': {
      if (session.ptyProcess && !session.processExited) {
        try { session.ptyProcess.write(data.data); }
        catch (e) { wsError(ws, 'WRITE_FAILED', `Write failed: ${e.message}`, session.id); }
      }
      break;
    }
    case 'resize': {
      const { cols, rows } = clampDims(data.cols, data.rows);
      session.lastCols = cols;
      session.lastRows = rows;
      if (session.ptyProcess && !session.processExited) {
        try { session.ptyProcess.resize(cols, rows); }
        catch (e) { wsError(ws, 'RESIZE_FAILED', `Resize failed: ${e.message}`, session.id); }
      }
      break;
    }
    case 'close': {
      // CR-006: set clientClosing unconditionally so respawn setTimeout also honors it
      session.clientClosing = true;
      if (session.ptyProcess && !session.processExited) {
        killPty(session.ptyProcess, session.id);
      } else {
        // PTY already exited — cleanup now (respawn setTimeout will see clientClosing=true and skip)
        cleanupSession(session);
      }
      break;
    }
    case 'pong': {
      const t = pongTimers.get(session.id); if (t) { clearTimeout(t); pongTimers.delete(session.id); }
      break;
    }
    default: wsError(ws, 'UNKNOWN_MESSAGE', `Unknown message type: ${data.type}`, session.id);
  }
}

// ─── Express app ────────────────────────────────────────────────────────────

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

// CR-001: serve only the specific xterm assets the frontend needs, not the entire node_modules tree
const NODE_MODULES_ROOT = path.join(__dirname, '..', 'node_modules');
const XTERM_ASSET_DIRS = [
  '@xterm/xterm/css',
  '@xterm/xterm/lib',
  '@xterm/addon-fit/lib',
  '@xterm/addon-web-links/lib',
];
for (const dir of XTERM_ASSET_DIRS) {
  const sub = path.join(NODE_MODULES_ROOT, dir);
  app.use(`/node_modules/${path.dirname(dir)}/${path.basename(dir)}`, express.static(sub));
}
// Expose each @xterm package root for /node_modules/@xterm/<pkg>/... resolution
app.use('/node_modules/@xterm/xterm', express.static(path.join(NODE_MODULES_ROOT, '@xterm', 'xterm')));
app.use('/node_modules/@xterm/addon-fit', express.static(path.join(NODE_MODULES_ROOT, '@xterm', 'addon-fit')));
app.use('/node_modules/@xterm/addon-web-links', express.static(path.join(NODE_MODULES_ROOT, '@xterm', 'addon-web-links')));

// Admitted-surface identity for Floyd Core discovery. Read from this copy's
// git HEAD at startup so the surface honestly reports the code it runs.
const SURFACE_IDENTITY = (() => {
  let sourceRoot = path.resolve(__dirname, '..');
  let sourceCommit = process.env.FLOYD_SOURCE_COMMIT || '';
  try {
    const { execFileSync } = require('node:child_process');
    sourceRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
    sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
  } catch { /* non-git deployment */ }
  return Object.freeze({
    surface_id: process.env.FLOYD_SURFACE_ID || 'launcher',
    source_root: sourceRoot,
    source_commit: sourceCommit || 'unverified',
  });
})();

app.get('/health', (req, res) => { res.json({ status: 'ok', sessions: activeSessions.size, identity: SURFACE_IDENTITY }); });
// Floyd Core probes /api/health for admitted-surface discovery.
app.get('/api/health', (req, res) => { res.json({ status: 'ok', sessions: activeSessions.size, identity: SURFACE_IDENTITY }); });
app.get('/harnesses', (req, res) => { res.json({ harnesses: HARNESSES }); });
app.get('/admin/sessions', (req, res) => {
  const sessions = Array.from(activeSessions.values()).map((s) => ({
    id: s.id, harness: s.harnessName || null, command: s.command || null,
    startedAt: s.startedAt || null, durationMs: s.startedAt ? Date.now() - s.startedAt : null,
    processExited: s.processExited
  }));
  res.json({ active: activeSessions.size, max: MAX_CONCURRENT_SESSIONS, sessions });
});
app.post('/admin/sessions/:id/kill', (req, res) => {
  const s = activeSessions.get(req.params.id);
  if (!s) { res.status(404).json({ error: 'Session not found' }); return; }
  cleanupSession(s);
  res.json({ ok: true, id: req.params.id });
});

// ─── HTTP + WebSocket server ────────────────────────────────────────────────

const server = http.createServer(app);
const allowedWebSocketOrigins = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
]);
const wss = new WebSocket.Server({
  server,
  verifyClient: ({ origin, req }, done) => {
    const hostAllowed = [`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(String(req.headers.host || ''));
    const testOverride = process.env.FLOYD_LAUNCHER_TEST_ALLOW_NO_ORIGIN === '1' && !origin;
    done(Boolean(hostAllowed && (allowedWebSocketOrigins.has(origin) || testOverride)), 403, 'same-origin launcher WebSocket required');
  },
});

wss.on('connection', (ws) => {
  const sessionId = crypto.randomUUID();
  /** @type {Session} */
  const session = { id: sessionId, harnessName: null, command: null, ptyProcess: undefined, sessionActive: true, processExited: false, clientClosing: false, ws, startedAt: Date.now() };

  const remoteAddr = ws.socket?.remoteAddress || null;
  info(sessionId, 'WebSocket connected', { ip: remoteAddr });

  ws.on('message', (message) => {
    try { handleMessage(session, ws, JSON.parse(message)); }
    catch (err) { error(sessionId, 'Failed to parse WS message', { err: err.message }); wsError(ws, 'PARSE_ERROR', 'Malformed JSON message', sessionId); }
  });

  ws.on('pong', () => {
    const t = pongTimers.get(sessionId); if (t) { clearTimeout(t); pongTimers.delete(sessionId); }
  });

  ws.on('close', (code, reason) => {
    info(sessionId, 'WebSocket disconnected', { code, reason: reason?.toString?.() || '' });
    session.sessionActive = false;
    if (session.ptyProcess) cleanupSession(session);
    else activeSessions.delete(sessionId);
  });

  ws.on('error', (err) => {
    error(sessionId, 'WebSocket error', { err: err.message || String(err) });
    session.sessionActive = false;
    if (session.ptyProcess) cleanupSession(session);
  });

  startHeartbeat(session);
});

// ─── Graceful shutdown ─────────────────────────────────────────────────────

/** @param {string} signal */
async function shutdown(signal) {
  info(null, `Received ${signal}, starting graceful shutdown`, { activeSessions: activeSessions.size });
  server.close();
  const promises = Array.from(activeSessions.values()).map((s) => {
    if (s.ptyProcess) killPty(s.ptyProcess, s.id);
    activeSessions.delete(s.id);
    return new Promise((r) => setTimeout(r, KILL_GRACE_MS + 100));
  });
  await Promise.race([Promise.all(promises), new Promise((r) => setTimeout(r, 5_000))]);
  info(null, 'Shutdown complete', { activeSessions: activeSessions.size });
  process.exit(0);
}

// CR-008: catch unhandled rejections/exceptions to prevent single-session crashes from taking down all sessions
process.on('unhandledRejection', (reason, promise) => {
  error(null, 'Unhandled promise rejection', { reason: String(reason).slice(0, 500) });
});
process.on('uncaughtException', (err) => {
  error(null, 'Uncaught exception — exiting for safety', { name: err.name, err: err.message, stack: (err.stack || '').split('\n').slice(0, 3).join(' | ') });
  // Node.js docs: "Attempting to resume normally after an uncaught exception can be unsafe."
  // Exit(1) protects concurrent sessions from corrupted state. unhandledRejection (above)
  // is non-fatal because the rejection may be from a single session's async path.
  process.exit(1);
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, HOST, () => {
  info(null, `Harness Launcher running at http://${HOST}:${PORT}`, { maxSessions: MAX_CONCURRENT_SESSIONS, host: HOST });
});
