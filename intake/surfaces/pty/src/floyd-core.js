'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { FLOYD_SDK_PROTOCOL_VERSION, FloydApiError, FloydClient } = require('@floyd/sdk');

const RUNTIME_ROOT = process.env.FLOYD_RUNTIME_ROOT || path.join(os.homedir(), '.floyd');
const CORE_URL = process.env.FLOYD_CORE_URL || `http://127.0.0.1:${process.env.FLOYD_CORE_PORT || 41414}`;
const PTY_SURFACE_ID = 'pty';
const PTY_CAPABILITIES = ['terminal-transport', 'experience-read', 'floyd-launch'];

function gatewayToken() {
  return fs.readFileSync(path.join(RUNTIME_ROOT, 'core', 'gateway.token'), 'utf8').trim();
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function admittedTuiBin() {
  const candidate = process.env.FLOYD_TUI_BIN || path.join(RUNTIME_ROOT, 'bin', 'floyd-tui');
  if (!path.isAbsolute(candidate)) throw new Error('FLOYD_TUI_BIN must be an absolute path');
  const stat = fs.statSync(candidate);
  if (!stat.isFile()) throw new Error(`FLOYD_TUI_BIN is not a file: ${candidate}`);
  fs.accessSync(candidate, fs.constants.X_OK);
  return candidate;
}

function trustedId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)) {
    throw new Error(`invalid Floyd ${label}`);
  }
  return value;
}

function trustedProjectRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Floyd project root must be absolute');
  const resolved = fs.realpathSync(value);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`Floyd project root is not a directory: ${resolved}`);
  return resolved;
}

/** Resolve one referentially consistent active continuation entirely from Core-owned state. */
async function resolveFloydLaunchContext(signal, expected = null) {
  const core = client();
  const envelope = await core.experience('primary', signal);
  const projectId = trustedId(envelope.active?.project_id, 'project ID');
  const sessionId = trustedId(envelope.active?.session_id, 'session ID');
  const runId = trustedId(envelope.active?.run_id, 'run ID');
  const eventId = envelope.last_event_id == null || envelope.last_event_id === ''
    ? null
    : trustedId(envelope.last_event_id, 'event ID');
  if (expected) {
    const expectedProjectId = trustedId(expected.projectId, 'expected project ID');
    const expectedSessionId = trustedId(expected.sessionId, 'expected session ID');
    const expectedRunId = trustedId(expected.runId, 'expected run ID');
    if (projectId !== expectedProjectId || sessionId !== expectedSessionId || runId !== expectedRunId) {
      throw new Error('active Floyd context no longer matches the requested remote continuation');
    }
  }
  const state = await core.state(signal);
  const project = state.projects?.find((candidate) => candidate.id === projectId);
  const session = state.sessions?.find((candidate) => candidate.id === sessionId);
  const run = state.runs?.find((candidate) => candidate.id === runId);
  if (!project) throw new Error(`active Floyd project is absent from Core state: ${projectId}`);
  if (!session || session.project_id !== projectId) throw new Error('active Floyd session does not belong to the restored project');
  if (!run || run.project_id !== projectId || run.session_id !== sessionId) {
    throw new Error('active Floyd run does not belong to the restored project and session');
  }
  return { projectId, sessionId, runId, eventId, rootPath: trustedProjectRoot(project.root_path) };
}

/** Launch the admitted semantic TUI in the Core-resolved project; browser input supplies no command data. */
function buildFloydShellCommand(context) {
  const projectId = trustedId(context?.projectId, 'project ID');
  const sessionId = trustedId(context?.sessionId, 'session ID');
  const runId = trustedId(context?.runId, 'run ID');
  const eventId = context?.eventId == null || context.eventId === ''
    ? null
    : trustedId(context.eventId, 'event ID');
  const rootPath = trustedProjectRoot(context?.rootPath);
  const eventArgument = eventId == null ? '' : ` --event ${shellQuote(eventId)}`;
  return `cd -- ${shellQuote(rootPath)} && ${shellQuote(admittedTuiBin())} floyd --project-id ${shellQuote(projectId)} --session ${shellQuote(sessionId)} --run ${shellQuote(runId)}${eventArgument}`;
}

function sendPayload(res, status, payload) {
  if (typeof payload === 'string') res.status(status).type('text/plain').send(payload);
  else res.status(status).json(payload);
}

function client() {
  return new FloydClient({ baseUrl: CORE_URL, token: gatewayToken });
}

function relayAbort(req, res) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortOnClose = () => { if (!res.writableEnded) abort(); };
  req.once('aborted', abort);
  res.once('close', abortOnClose);
  return {
    controller,
    cleanup() {
      req.off('aborted', abort);
      res.off('close', abortOnClose);
    }
  };
}

function forwardError(res, error) {
  if (res.writableEnded) return;
  if (error instanceof FloydApiError) {
    sendPayload(res, error.status, error.payload);
    return;
  }
  res.status(503).json({
    error: {
      type: 'floyd_core_unavailable',
      message: error instanceof Error ? error.message : String(error)
    }
  });
}

function requireLoopback(req, res, next) {
  const address = req.socket?.remoteAddress || '';
  const loopback = address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
  if (loopback) {
    next();
    return;
  }
  res.status(403).json({ error: { type: 'loopback_required', message: 'Floyd adapters are loopback-only' } });
}

/**
 * Relay only Core health through the server-side SDK. Request abort and response
 * close both cancel the outbound fetch; the gateway token stays server-side.
 */
async function forwardFloydHealth(req, res) {
  const lifecycle = relayAbort(req, res);

  try {
    sendPayload(res, 200, await client().health(lifecycle.controller.signal));
  } catch (error) {
    if (!lifecycle.controller.signal.aborted) forwardError(res, error);
  } finally {
    lifecycle.cleanup();
  }
}

async function negotiateFloydExperience(req, res) {
  const lifecycle = relayAbort(req, res);
  try {
    const result = await client().negotiateExperience({
      surface_id: PTY_SURFACE_ID,
      sdk_version: FLOYD_SDK_PROTOCOL_VERSION,
      capabilities: PTY_CAPABILITIES
    }, lifecycle.controller.signal);
    sendPayload(res, 200, result);
  } catch (error) {
    if (!lifecycle.controller.signal.aborted) forwardError(res, error);
  } finally {
    lifecycle.cleanup();
  }
}

async function forwardFloydExperience(req, res) {
  const lifecycle = relayAbort(req, res);
  try {
    sendPayload(res, 200, await client().experience('primary', lifecycle.controller.signal));
  } catch (error) {
    if (!lifecycle.controller.signal.aborted) forwardError(res, error);
  } finally {
    lifecycle.cleanup();
  }
}

async function publishFloydPresence(req, res) {
  const lifecycle = relayAbort(req, res);
  try {
    const expectedRevision = Number(req.body?.expected_revision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      res.status(400).json({ error: { type: 'invalid_request', message: 'expected_revision must be an integer' } });
      return;
    }
    const core = client();
    const current = await core.experience('primary', lifecycle.controller.signal);
    const envelope = await core.updateExperience('primary', {
      expected_revision: expectedRevision,
      surface: {
        surface_id: PTY_SURFACE_ID,
        sdk_version: FLOYD_SDK_PROTOCOL_VERSION,
        capabilities: PTY_CAPABILITIES,
        transcript_cursor: current.transcript_cursor,
        transcript_epoch: current.transcript_epoch,
        last_event_id: current.last_event_id
      }
    }, lifecycle.controller.signal);
    sendPayload(res, 200, envelope);
  } catch (error) {
    if (!lifecycle.controller.signal.aborted) forwardError(res, error);
  } finally {
    lifecycle.cleanup();
  }
}

function writeSse(res, event) {
  const lines = [];
  if (event.id) lines.push(`id: ${event.id}`);
  lines.push(`event: ${event.type || 'message'}`);
  lines.push(`data: ${JSON.stringify(event.data)}`);
  return res.write(`${lines.join('\n')}\n\n`);
}

function waitForDrain(res, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (value) => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onDrain = () => done(true);
    const onClose = () => done(false);
    const onAbort = () => done(false);
    res.once('drain', onDrain);
    res.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function streamFloydExperience(req, res) {
  const lifecycle = relayAbort(req, res);
  const stream = client().watchExperience('primary', {
    lastEventId: req.headers['last-event-id'],
    signal: lifecycle.controller.signal
  });
  let started = false;
  try {
    for await (const event of stream) {
      if (!started) {
        res.status(200);
        res.set({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive'
        });
        res.flushHeaders();
        started = true;
      }
      if (!writeSse(res, event) && !await waitForDrain(res, lifecycle.controller.signal)) break;
    }
    if (!res.writableEnded) res.end();
  } catch (error) {
    if (!lifecycle.controller.signal.aborted) {
      if (!started) forwardError(res, error);
      else {
        writeSse(res, {
          type: 'error',
          data: error instanceof FloydApiError
            ? { status: error.status, payload: error.payload }
            : { status: 503, payload: { error: { type: 'floyd_core_unavailable', message: String(error) } } }
        });
        res.end();
      }
    }
  } finally {
    await stream.return?.();
    lifecycle.cleanup();
  }
}

module.exports = {
  PTY_CAPABILITIES,
  PTY_SURFACE_ID,
  buildFloydShellCommand,
  forwardFloydExperience,
  forwardFloydHealth,
  negotiateFloydExperience,
  publishFloydPresence,
  requireLoopback,
  resolveFloydLaunchContext,
  streamFloydExperience
};
