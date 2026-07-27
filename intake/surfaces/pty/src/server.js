'use strict';

const express = require('express');
const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');

const WebSocket = require('ws');
const pty = require('node-pty');
const { randomUUID } = require('node:crypto');
const {
  buildFloydShellCommand,
  forwardFloydExperience,
  forwardFloydHealth,
  negotiateFloydExperience,
  publishFloydPresence,
  requireLoopback,
  resolveFloydLaunchContext,
  streamFloydExperience
} = require('./floyd-core');
const { installWebSocketAuth } = require('./ws-auth');

// ─── Constants ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 11001;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_CONCURRENT_SESSIONS = 10;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 1_000;
const MAX_COLS = 500;
const MAX_ROWS = 200;
const SURFACE_IDENTITY = (() => {
  // Admitted-surface identity for Floyd Core discovery. Read from this copy's
  // git HEAD at startup so the surface honestly reports the code it runs.
  let sourceRoot = path.resolve(__dirname, '..');
  let sourceCommit = process.env.FLOYD_SURFACE_COMMIT || '';
  try {
    const { execFileSync } = require('node:child_process');
    sourceRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
    if (!sourceCommit) {
      sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
    }
  } catch { /* non-git deployment */ }
  return Object.freeze({
    surface_id: process.env.FLOYD_SURFACE_ID || 'pty',
    source_root: sourceRoot,
    source_commit: sourceCommit || 'unverified',
  });
})();

// Resume: when a WS drops unexpectedly, keep the PTY alive this long so the
// client can reconnect to the same session. Output produced while detached
// (and while attached) is buffered in a ring and replayed on resume.
const RESUME_GRACE_MS = 5 * 60 * 1000;
const RESUME_BUFFER_MAX = 512 * 1024;

// ─── In-memory state ──────────────────────────────────────────────────────────

/** @type {Map<string, Session>} */
const activeSessions = new Map();

/** @type {Map<string, NodeJS.Timeout>} */
const pingTimers = new Map();

/** @type {Map<string, NodeJS.Timeout>} */
const pongTimers = new Map();

/** @type {Map<string, NodeJS.Timeout>} */
const graceTimers = new Map();

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

/** Count sessions running a live shell, optionally excluding one id. */
function countRealShells(excludeId) {
  let n = 0;
  for (const s of activeSessions.values()) {
    if (s.id === excludeId) continue;
    if (s.ptyProcess && !s.processExited) n += 1;
  }
  return n;
}

/** @param {import('ws').WebSocket} ws @param {string} code @param {string} message @param {string|null} id */
function wsError(ws, code, message, id) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: 'error', code, message })); }
    catch (e) { error(id, 'WS send error failed', { code, err: e.message }); }
  }
}

/** Send a JSON message to a session's *current* ws if it is open. */
function sendToSession(session, payload) {
  const ws = session.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(JSON.stringify(payload)); return true; }
  catch (e) { error(session.id, 'WS send failed', { err: e.message }); return false; }
}

// ─── Output ring buffer ──────────────────────────────────────────────────────

/** Append PTY output to the session ring, evicting from the head when capped. */
function bufferOutput(session, data) {
  session.outputBuffer += data;
  if (session.outputBuffer.length > RESUME_BUFFER_MAX) {
    // Keep only the tail beyond the cap so the most recent output survives.
    const over = session.outputBuffer.length - RESUME_BUFFER_MAX;
    session.outputBuffer = session.outputBuffer.slice(over);
  }
}

// ─── PTY helpers ────────────────────────────────────────────────────────────

/** @param {import('node-pty').IPty|undefined} ptyProcess @param {string} id */
function killPty(ptyProcess, id) {
  if (!ptyProcess || typeof ptyProcess.kill !== 'function') return;
  try { ptyProcess.kill('SIGTERM'); }
  catch (e) { warn(id, 'SIGTERM failed — already dead', { err: e.message }); return; }
  const timer = setTimeout(() => {
    try { if (ptyProcess && typeof ptyProcess.kill === 'function') ptyProcess.kill('SIGKILL'); }
    catch (_) {}
  }, KILL_GRACE_MS);
  if (typeof ptyProcess.once === 'function') ptyProcess.once('exit', () => clearTimeout(timer));
}

// ─── Session lifecycle ───────────────────────────────────────────────────────

/** Clear the resume grace timer for a session, if any. */
function clearGraceTimer(session) {
  const gt = graceTimers.get(session.id);
  if (gt) { clearTimeout(gt); graceTimers.delete(session.id); }
}

function cleanupSession(session) {
  const { id, ptyProcess } = session;
  info(id, 'Cleaning up session');

  clearGraceTimer(session);

  const pt = pingTimers.get(id);
  clearInterval(pt);
  pingTimers.delete(id);
  const po = pongTimers.get(id);
  clearTimeout(po);
  pongTimers.delete(id);

  if (ptyProcess) { killPty(ptyProcess, id); session.ptyProcess = undefined; }
  activeSessions.delete(id);
  info(id, 'Session cleaned up');
}

/** @param {Session} session */
function startHeartbeat(session) {
  const { id } = session;
  // Replace any prior interval for this session.
  clearInterval(pingTimers.get(id));

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

/** Stop the heartbeat ping interval for a session (used when detaching). */
function stopHeartbeat(session) {
  const { id } = session;
  clearInterval(pingTimers.get(id));  pingTimers.delete(id);
  clearTimeout(pongTimers.get(id));  pongTimers.delete(id);
}

// ─── PTY event wiring ──────────────────────────────────────────────────────

/**
 * Attach PTY data/exit/error handlers to a session. The data handler reads
 * `session.ws` dynamically so a re-attached WebSocket (resume) receives output
 * without rewiring.
 * @param {import('node-pty').IPty} ptyProcess
 * @param {Session} session
 */
function wirePtyToSession(ptyProcess, session) {
  const { id } = session;

  ptyProcess.onData((data) => {
    // Always buffer so a subsequent resume can replay this output.
    bufferOutput(session, data);
    if (!session.sessionActive) return;
    sendToSession(session, { type: 'output', data });
  });

  ptyProcess.once('exit', (code) => {
    if (session.processExited) return;
    session.processExited = true;
    info(id, 'Shell exited, respawning', { code });

    // If detached when the shell exits, there is nobody to receive a respawn —
    // tear the session down.
    if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
      cleanupSession(session);
      return;
    }
    if (!session.sessionActive) { cleanupSession(session); return; }

    try { session.ws.send(JSON.stringify({ type: 'shell-reset', code: code || 0 })); }
    catch (_) {}
    setTimeout(() => {
      if (session.sessionActive && session.ws && session.ws.readyState === WebSocket.OPEN) {
        spawnShell(session, session.shellCwd);
      } else {
        cleanupSession(session);
      }
    }, 50);
  });

  ptyProcess.on('error', (err) => {
    error(id, 'PTY error', { err: err.message || String(err) });
    if (session.ws) wsError(session.ws, 'PROCESS_ERROR', `Process error: ${err.message || String(err)}`, id);
    cleanupSession(session);
  });
}

// ─── Shell spawn helper ─────────────────────────────────────────────────────

/**
 * Spawn the user's default shell into the session and wire it up.
 * @param {Session} session
 * @param {string} [cwd]
 */
function spawnShell(session, cwd) {
  const { id } = session;
  const cols = session.lastCols || 120;
  const rows = session.lastRows || 40;

  let workingDir = cwd || process.env.HOME || os.homedir();
  if (!fs.existsSync(workingDir)) workingDir = os.homedir();

  const ptyEnv = { ...process.env, TERM: 'xterm-256color' };
  const shell = process.env.SHELL || '/bin/zsh';

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
  session.startedAt = Date.now();
  activeSessions.set(id, session);
  wirePtyToSession(ptyProcess, session);
}

// ─── Resume: re-attach a new WebSocket to an existing session ────────────────

/**
 * Re-attach `ws` onto an existing resumable session, replay buffered output,
 * and resume live delivery.
 *
 * Handlers are bound to the WebSocket once at connect time and read the active
 * session through `ws.__sessionRef` (a mutable property). On resume we simply
 * re-point that property at the target session — no second set of listeners is
 * registered, so there is no double-dispatch.
 * @param {Session} target
 * @param {import('ws').WebSocket} ws
 * @param {{ cols: number, rows: number }} dims
 * @param {Session} placeholder  The throwaway connection session to retire.
 */
function resumeSession(target, ws, dims, placeholder) {
  const { id } = target;
  const bufferedBytes = target.outputBuffer ? target.outputBuffer.length : 0;

  // Retire the placeholder connection session (the one created at connect).
  activeSessions.delete(placeholder.id);
  stopHeartbeat(placeholder);

  // Adopt the new connection onto the target session.
  target.ws = ws;
  target.sessionActive = true;
  ws.__sessionRef = target; // re-point handlers at the resumed session

  // Cancel the resume grace countdown — we're live again.
  clearGraceTimer(target);

  // Resize the live PTY to the new client viewport.
  target.lastCols = dims.cols;
  target.lastRows = dims.rows;
  if (target.ptyProcess && !target.processExited) {
    try { target.ptyProcess.resize(dims.cols, dims.rows); }
    catch (e) { warn(id, 'resume resize failed', { err: e.message }); }
  }

  // Restart heartbeat for the new socket.
  startHeartbeat(target);

  // Acknowledge resume, then replay buffered output into the fresh terminal.
  sendToSession(target, {
    type: 'ready',
    sessionId: id,
    command: target.command || process.env.SHELL || '/bin/zsh',
    cwd: target.shellCwd,
    resumed: true
  });

  if (target.outputBuffer) {
    const buf = target.outputBuffer;
    target.outputBuffer = '';
    // Send in chunks to avoid a single oversized WS frame.
    const CHUNK = 16 * 1024;
    for (let i = 0; i < buf.length; i += CHUNK) {
      sendToSession(target, { type: 'output', data: buf.slice(i, i + CHUNK) });
    }
  }

  info(id, 'Session resumed', { bufferedBytes });
}

// ─── Message dispatcher ─────────────────────────────────────────────────────

/** @param {Session} session @param {import('ws').WebSocket} ws @param {object} data */
function handleMessage(session, ws, data) {
  if (!session.sessionActive && data.type !== 'resume' && data.type !== 'shell') return;

  switch (data.type) {
    case 'shell': {
      if (session.ptyProcess && !session.processExited) {
        try { session.ptyProcess.kill(); } catch (_) {}
      }
      const { cols, rows } = clampDims(data.cols, data.rows);
      session.lastCols = cols;
      session.lastRows = rows;
      // Enforce the concurrent-shell cap. Fresh spawns only — resume reuses an
      // existing session and is exempt. The current (placeholder) session has no
      // PTY yet and is excluded from the count.
      if (countRealShells(session.id) >= MAX_CONCURRENT_SESSIONS) {
        wsError(ws, 'SESSION_LIMIT', 'Maximum concurrent sessions reached', session.id);
        break;
      }
      spawnShell(session, data.cwd || process.env.HOME || os.homedir());
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ready', sessionId: session.id, command: process.env.SHELL || '/bin/zsh', cwd: session.shellCwd }));
      }
      break;
    }
    case 'resume': {
      // Look up the requested session and adopt it onto this connection.
      const targetId = String(data.sessionId || '');
      const target = activeSessions.get(targetId);
      if (target && target.ptyProcess && !target.processExited) {
        resumeSession(target, ws, clampDims(data.cols, data.rows), session);
      } else {
        info(session.id, 'Resume failed — target not resumable', { targetId });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resume-failed', sessionId: targetId, reason: 'not-found' }));
        }
      }
      break;
    }
    case 'input': {
      if (session.ptyProcess && !session.processExited && typeof data.data === 'string') {
        try { session.ptyProcess.write(data.data); }
        catch (e) { wsError(ws, 'WRITE_FAILED', `Write failed: ${e.message}`, session.id); }
      }
      break;
    }
    case 'floyd': {
      if (!session.ptyProcess || session.processExited) {
        wsError(ws, 'NO_ACTIVE_SHELL', 'Start or resume a shell before launching Floyd', session.id);
        break;
      }
      if (session.floydLaunchPending) break;
      session.floydLaunchPending = true;
      const controller = new AbortController();
      const abort = () => controller.abort();
      ws.once('close', abort);
      void resolveFloydLaunchContext(controller.signal, data.context || null).then((context) => {
        if (controller.signal.aborted || session.ws !== ws || !session.ptyProcess || session.processExited) return;
        session.ptyProcess.write(buildFloydShellCommand(context) + '\r');
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'floyd-ready', sessionId: session.id, projectId: context.projectId }));
        }
      }).catch((e) => {
        if (!controller.signal.aborted) wsError(ws, 'FLOYD_LAUNCH_FAILED', `Could not prepare Floyd Core CLI: ${e.message}`, session.id);
      }).finally(() => {
        ws.off('close', abort);
        session.floydLaunchPending = false;
      });
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
      // Explicit user-initiated close → full teardown of this session.
      session.userClosed = true;
      if (session.ptyProcess && !session.processExited) cleanupSession(session);
      break;
    }
    case 'ping': {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'pong', ts: data.ts }));
      }
      break;
    }
    case 'pong': {
      clearTimeout(pongTimers.get(session.id));
      pongTimers.delete(session.id);
      break;
    }
    default: wsError(ws, 'UNKNOWN_MESSAGE', `Unknown message type: ${data.type}`, session.id);
  }
}

// ─── WS event binding ───────────────────────────────────────────────────────

/**
 * Bind a freshly-connected WS onto a session. Handlers read the active session
 * through `ws.__sessionRef`, so a resume that re-points that property needs no
 * re-registration (and therefore cannot double-dispatch).
 * @param {import('ws').WebSocket} ws
 * @param {Session} session
 */
function bindWsToSession(ws, session) {
  ws.__sessionRef = session;

  const remoteAddr = ws._socket?.remoteAddress || null;
  info(session.id, 'WebSocket connected', { ip: remoteAddr });

  ws.on('message', (message) => {
    const s = ws.__sessionRef;
    if (!s) return;
    try { handleMessage(s, ws, JSON.parse(message)); }
    catch (err) { error(s.id, 'Failed to parse WS message', { err: err.message }); wsError(ws, 'PARSE_ERROR', 'Malformed JSON message', s.id); }
  });

  ws.on('pong', () => {
    const s = ws.__sessionRef;
    if (!s) return;
    clearTimeout(pongTimers.get(s.id));
    pongTimers.delete(s.id);
  });

  ws.on('close', (code, reason) => {
    const s = ws.__sessionRef;
    if (!s) return;
    info(s.id, 'WebSocket disconnected', { code, reason: reason?.toString?.() || '', userClosed: !!s.userClosed });

    // Explicit close already cleaned up the session; ensure the placeholder is gone.
    if (s.userClosed) {
      activeSessions.delete(s.id);
      return;
    }
    // Unexpected drop: keep the PTY alive and start the resume grace window.
    if (s.ptyProcess && !s.processExited) {
      s.ws = null;
      s.sessionActive = false;
      stopHeartbeat(s);
      if (!graceTimers.has(s.id)) {
        info(s.id, 'Session entering resume grace', { graceMs: RESUME_GRACE_MS });
        const gt = setTimeout(() => {
          warn(s.id, 'Resume grace expired — cleaning up detached session');
          cleanupSession(s);
        }, RESUME_GRACE_MS);
        graceTimers.set(s.id, gt);
      }
    } else {
      // No live PTY to preserve — just drop the placeholder.
      activeSessions.delete(s.id);
    }
  });

  ws.on('error', (err) => {
    const s = ws.__sessionRef;
    error(s ? s.id : null, 'WebSocket error', { err: err.message || String(err) });
    // An error does not necessarily kill the socket; mark inactive and let the
    // close handler decide grace vs cleanup.
    if (s) s.sessionActive = false;
  });
}

// ─── Express app ────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '16kb' }));
// App assets are served with no-store so the browser always runs the latest
// frontend (critical during input/dictation iteration — a cached input-guard.mjs
// silently reproduces already-fixed echo bugs).
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));
app.use('/node_modules', express.static(path.join(__dirname, '..', 'node_modules')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: activeSessions.size, identity: SURFACE_IDENTITY });
});
// Floyd Core probes /api/health for admitted-surface discovery.
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', sessions: activeSessions.size, identity: SURFACE_IDENTITY });
});
app.get('/api/floyd/health', requireLoopback, forwardFloydHealth);
app.post('/api/floyd/experience/negotiate', requireLoopback, negotiateFloydExperience);
app.get('/api/floyd/experience', requireLoopback, forwardFloydExperience);
app.post('/api/floyd/experience/presence', requireLoopback, publishFloydPresence);
app.get('/api/floyd/experience/stream', requireLoopback, streamFloydExperience);
app.get('/admin/sessions', (req, res) => {
  const sessions = Array.from(activeSessions.values()).map((s) => {
    const resumable = !s.ws && !!s.ptyProcess && !s.processExited && graceTimers.has(s.id);
    return {
      id: s.id, command: s.command || process.env.SHELL || '/bin/zsh',
      startedAt: s.startedAt || null, durationMs: s.startedAt ? Date.now() - s.startedAt : null,
      processExited: s.processExited,
      attached: !!s.ws,
      resumable,
      bufferedBytes: s.outputBuffer ? s.outputBuffer.length : 0
    };
  });
  const resumableCount = sessions.filter((s) => s.resumable).length;
  res.json({ active: activeSessions.size, max: MAX_CONCURRENT_SESSIONS, resumableCount, sessions });
});
app.post('/admin/sessions/:id/kill', (req, res) => {
  const s = activeSessions.get(req.params.id);
  if (!s) { res.status(404).json({ error: 'Session not found' }); return; }
  cleanupSession(s);
  res.json({ ok: true, id: req.params.id });
});

// ─── HTTP + WebSocket server ────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
const ALLOWED_ORIGIN = process.env.TERMINALONE_ALLOWED_ORIGIN || `http://${HOST}:${PORT}`;
installWebSocketAuth({ app, server, wss, allowedOrigin: ALLOWED_ORIGIN });

// Bind failures used to surface as an unhandled WebSocketServer exception.
// Keep the failure explicit and structured without pretending the app started.
server.on('error', (err) => {
  error(null, 'HTTP server error', { code: err.code || null, err: err.message });
  process.exitCode = 1;
});
wss.on('error', (err) => {
  error(null, 'WebSocket server error', { code: err.code || null, err: err.message });
  process.exitCode = 1;
});

wss.on('connection', (ws) => {
  // Each connection starts as a fresh placeholder session. It becomes "real"
  // when the client sends `shell`, or it adopts an existing session via `resume`.
  const sessionId = randomUUID();
  /** @type {Session} */
  const session = {
    id: sessionId,
    command: null,
    ptyProcess: undefined,
    sessionActive: true,
    processExited: false,
    ws,
    startedAt: Date.now(),
    outputBuffer: '',
    userClosed: false
  };
  activeSessions.set(sessionId, session);

  bindWsToSession(ws, session);
  startHeartbeat(session);
});

// ─── Graceful shutdown ─────────────────────────────────────────────────────

/** @param {string} signal */
async function shutdown(signal) {
  info(null, `Received ${signal}, starting graceful shutdown`, { activeSessions: activeSessions.size });
  server.close();
  const promises = Array.from(activeSessions.values()).map((s) => {
    clearGraceTimer(s);
    if (s.ptyProcess) killPty(s.ptyProcess, s.id);
    activeSessions.delete(s.id);
    return new Promise((r) => setTimeout(r, KILL_GRACE_MS + 100));
  });
  await Promise.race([Promise.all(promises), new Promise((r) => setTimeout(r, 5_000))]);
  info(null, 'Shutdown complete', { activeSessions: activeSessions.size });
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, HOST, () => {
  info(null, `TerminalOne running at http://${HOST}:${PORT}`, { maxSessions: MAX_CONCURRENT_SESSIONS, host: HOST });
});
