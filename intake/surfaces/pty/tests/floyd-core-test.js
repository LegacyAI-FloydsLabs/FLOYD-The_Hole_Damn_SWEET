#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { buildFloydShellCommand, requireLoopback } = require('../src/floyd-core');
const { allowedOrigin, createTestWebSocket, requestTicket } = require('./ws-test-client');

const TOKEN = 'test-gateway-token';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function expectUpgradeRejected(url, options, expectedStatus) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      if (response.statusCode === expectedStatus) resolve();
      else reject(new Error(`expected WebSocket HTTP ${expectedStatus}, received ${response.statusCode}`));
    });
    socket.once('open', () => reject(new Error(`WebSocket unexpectedly opened; expected HTTP ${expectedStatus}`)));
    socket.once('error', () => {});
  });
}

function openWebSocket(url, origin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Origin: origin } });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: pathname }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.once('error', reject);
  });
}

function post(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? '' : JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: encoded ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) } : {}
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: responseBody }));
    });
    request.once('error', reject);
    request.end(encoded);
  });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

async function waitForSurface(port) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await get(port, '/health')).status === 200) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('TerminalOne did not become healthy');
}

async function run() {
  const browserShell = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(browserShell, /integratedFloydMarker === 'continue'/, 'integrated workspace recognizes the continuation marker');
  assert.match(browserShell, /integratedFloydMarker === 'integrated'/, 'integrated workspace recognizes the non-launching embed marker');
  assert.match(browserShell, /launchQuery\.delete\('floyd'\)[\s\S]*history\.replaceState/, 'continuation marker is removed from browser history');
  assert.match(browserShell, /terminalReadyForFloyd = !msg\.resumed[\s\S]*maybeLaunchIntegratedFloyd\(\)/, 'a fresh integrated terminal waits on the unified continuation gate');
  assert.match(browserShell, /remoteContextRequired[\s\S]*!integratedFloydContext[\s\S]*integratedFloydStarted = true[\s\S]*queueMicrotask\(launchFloyd\)/, 'remote TUI launch waits for its bounded context and still runs exactly once');
  assert.doesNotMatch(browserShell, /integratedFloydEmbedded &&[^\n]*launchFloyd/, 'the embed cache-busting marker never launches Floyd');
  assert.match(browserShell, /event\.source !== window\.parent[\s\S]*unifiedParentOriginAllowed\(event\.origin\)[\s\S]*floyd:surface-close[\s\S]*requestId\.length > 160[\s\S]*closeConnection\(\);[\s\S]*floyd:surface-closed[\s\S]*requestId/, 'the admitted local or remote parent receives a bounded-request acknowledgement after explicit PTY teardown is issued');
  assert.match(browserShell, /floyd:continue-context[\s\S]*integratedFloydContext[\s\S]*type: 'floyd'[\s\S]*context: integratedFloydContext/, 'remote semantic continuation passes only bounded Floyd identifiers from the admitted parent');
  assert.doesNotMatch(browserShell, /[?&](session|run|event|token|secret)=/i, 'integrated URL carries no Core identity or credential');
  let mode = 'ok';
  let delayedStarted;
  let resolveDelayedStarted;
  let upstreamClosed = false;
  let experienceStreamClosed = false;
  let revision = 3;
  let lastPresencePatch = null;
  let coreRequests = 0;
  let projectRoot;
  const experience = () => ({
    id: 'primary', schema_version: '1.0.0', revision,
    active: mode === 'missing-context'
      ? { project_id: 'project-1', session_id: null, run_id: 'run-1' }
      : { project_id: 'project-1', session_id: 'session-1', run_id: 'run-1' },
    model_route: { provider: null, model: null, base_url: null, provider_profile_id: null, credential_ref: null },
    transcript_cursor: 21, transcript_epoch: 'epoch-1', last_event_id: '21',
    pending_questions: [], pending_permissions: [], composer_draft: '',
    selected_artifact_id: null, selected_view: 'tui:run', surfaces: {},
    updated_at: '2026-07-14T00:00:00.000Z', updated_by_device_id: null
  });
  const fakeCore = http.createServer(async (request, response) => {
    coreRequests += 1;
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    if (mode === 'unauthorized') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'auth', message: 'exact upstream auth failure' } }));
      return;
    }
    if (mode === 'delay' && request.url === '/api/health') {
      response.on('close', () => { upstreamClosed = true; });
      resolveDelayedStarted();
      return;
    }
    if (request.url === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', engine: { healthy: true, name: 'fake-opencode' } }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/experience/negotiate') {
      const body = await readJson(request);
      assert.equal(body.surface_id, 'pty');
      assert.deepEqual(body.capabilities, ['terminal-transport', 'experience-read', 'floyd-launch']);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ accepted: true, envelope_version: '1.0.0', core_protocol_version: '1.0.0', minimum_sdk_version: '1.0.0' }));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/experience/primary') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(experience()));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/state') {
      const stateProjectId = mode === 'wrong-project' ? 'project-2' : 'project-1';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        projects: [{ id: stateProjectId, name: 'test', root_path: projectRoot }],
        sessions: [{ id: 'session-1', project_id: stateProjectId }],
        runs: [{ id: 'run-1', project_id: stateProjectId, session_id: 'session-1' }],
        jobs: [], leases: [], provider_profiles: [], experience: experience()
      }));
      return;
    }
    if (request.method === 'PATCH' && request.url === '/api/experience/primary') {
      lastPresencePatch = await readJson(request);
      if (lastPresencePatch.expected_revision !== revision) {
        response.writeHead(409, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'revision_conflict', envelope: experience() }));
        return;
      }
      revision += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(experience()));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/experience/primary/stream') {
      response.on('close', () => { experienceStreamClosed = true; });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`id: ${revision}\nevent: experience\ndata: ${JSON.stringify(experience())}\n\n`);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  const corePort = await listen(fakeCore);

  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'terminalone-floyd-test-'));
  fs.mkdirSync(path.join(runtimeRoot, 'core'));
  fs.writeFileSync(path.join(runtimeRoot, 'core', 'gateway.token'), TOKEN, { mode: 0o600 });
  projectRoot = path.join(runtimeRoot, 'active project');
  fs.mkdirSync(projectRoot);
  const tuiBin = path.join(runtimeRoot, 'fake-omp');
  fs.writeFileSync(tuiBin, '#!/bin/sh\nprintf "FLOYD_TUI_CWD:%s\\n" "$PWD"\nprintf "FLOYD_TUI_LAUNCHED:%s\\n" "$*"\n', { mode: 0o700 });
  delete process.env.FLOYD_TUI_BIN;
  const launchContext = {
    projectId: 'project-1', sessionId: 'session-1', runId: 'run-1', eventId: '21', rootPath: projectRoot
  };
  const defaultLaunchCommand = buildFloydShellCommand(launchContext);
  assert.match(defaultLaunchCommand, /cd -- .*active project.*\/Volumes\/Storage\/FLOYD_RUNTIME\/bin\/floyd-tui.*floyd --project-id 'project-1' --session 'session-1' --run 'run-1' --event '21'/);
  assert.doesNotMatch(defaultLaunchCommand, /(^|[ ;])omp([ ;]|$)/, 'default launch never resolves omp from PATH');
  process.env.FLOYD_TUI_BIN = 'relative-omp';
  assert.throws(() => buildFloydShellCommand(launchContext), /must be an absolute path/);
  process.env.FLOYD_TUI_BIN = tuiBin;
  const launchCommand = buildFloydShellCommand(launchContext);
  assert.match(launchCommand, /fake-omp.*floyd --project-id 'project-1' --session 'session-1' --run 'run-1' --event '21'/);
  assert.doesNotMatch(launchCommand, /(^|[ ;])omp([ ;]|$)/, 'launch never falls through to a PATH-resolved omp');
  assert.throws(() => buildFloydShellCommand({ ...launchContext, projectId: "project-1'; touch /tmp/owned" }), /invalid Floyd project ID/);
  assert.throws(() => buildFloydShellCommand({ ...launchContext, sessionId: undefined }), /invalid Floyd session ID/);
  assert.throws(() => buildFloydShellCommand({ ...launchContext, runId: undefined }), /invalid Floyd run ID/);
  assert.throws(() => buildFloydShellCommand({ ...launchContext, eventId: "21'; touch /tmp/owned" }), /invalid Floyd event ID/);
  assert.doesNotMatch(buildFloydShellCommand({ ...launchContext, eventId: null }), / --event /);

  let loopbackNext = false;
  let deniedStatus = null;
  let deniedPayload = null;
  requireLoopback({ socket: { remoteAddress: '192.168.1.44' } }, {
    status(status) { deniedStatus = status; return this; },
    json(payload) { deniedPayload = payload; }
  }, () => { loopbackNext = true; });
  assert.equal(loopbackNext, false);
  assert.equal(deniedStatus, 403);
  assert.equal(deniedPayload.error.type, 'loopback_required');
  assert.equal(coreRequests, 0, 'non-loopback rejection does not contact Core');

  const reservation = http.createServer();
  const surfacePort = await listen(reservation);
  await close(reservation);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(surfacePort),
      HOST: '127.0.0.1',
      FLOYD_CORE_URL: `http://127.0.0.1:${corePort}`,
      FLOYD_CORE_PORT: String(corePort),
      FLOYD_RUNTIME_ROOT: runtimeRoot,
      FLOYD_WORKSTATION_ROOT: '/Volumes/Storage/FLOYD_WORKSTATION',
      FLOYD_TUI_BIN: tuiBin,
      FLOYD_SURFACE_COMMIT: 'pty-test-commit',
      TERMINALONE_ALLOWED_ORIGIN: `http://127.0.0.1:${surfacePort}`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });

  try {
    await waitForSurface(surfacePort);
    const admittedHealth = JSON.parse((await get(surfacePort, '/health')).body);
    assert.deepEqual(admittedHealth.identity, {
      surface_id: 'pty',
      source_root: path.join(__dirname, '..'),
      source_commit: 'pty-test-commit'
    });
    const origin = allowedOrigin(surfacePort);
    const wsBase = `ws://127.0.0.1:${surfacePort}/ws`;
    await assert.rejects(() => requestTicket(surfacePort, 'https://hostile.example'), /ticket request failed \(403\)/);
    await expectUpgradeRejected(wsBase, undefined, 403);
    await expectUpgradeRejected(wsBase, { headers: { Origin: origin } }, 401);
    const singleUseTicket = await requestTicket(surfacePort, origin);
    const ticketUrl = `${wsBase}?ticket=${encodeURIComponent(singleUseTicket)}`;
    await expectUpgradeRejected(ticketUrl, { headers: { Origin: 'https://hostile.example' } }, 403);
    const admitted = await openWebSocket(ticketUrl, origin);
    admitted.close();
    await new Promise((resolve) => admitted.once('close', resolve));
    await expectUpgradeRejected(ticketUrl, { headers: { Origin: origin } }, 401);

    const health = await get(surfacePort, '/api/floyd/health');
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { status: 'ok', engine: { healthy: true, name: 'fake-opencode' } });

    const negotiation = await post(surfacePort, '/api/floyd/experience/negotiate');
    assert.equal(negotiation.status, 200);
    assert.equal(JSON.parse(negotiation.body).accepted, true);
    const current = await get(surfacePort, '/api/floyd/experience');
    assert.equal(current.status, 200);
    assert.equal(JSON.parse(current.body).active.run_id, 'run-1');
    const presence = await post(surfacePort, '/api/floyd/experience/presence', { expected_revision: revision });
    assert.equal(presence.status, 200);
    assert.deepEqual(Object.keys(lastPresencePatch).sort(), ['expected_revision', 'surface']);
    assert.deepEqual(lastPresencePatch.surface, {
      surface_id: 'pty', sdk_version: '1.0.0',
      capabilities: ['terminal-transport', 'experience-read', 'floyd-launch'],
      transcript_cursor: 21, transcript_epoch: 'epoch-1', last_event_id: '21'
    });

    const stalePresence = await post(surfacePort, '/api/floyd/experience/presence', { expected_revision: revision - 1 });
    assert.equal(stalePresence.status, 409);
    assert.equal(JSON.parse(stalePresence.body).error, 'revision_conflict');

    await new Promise((resolve, reject) => {
      const request = http.get({ hostname: '127.0.0.1', port: surfacePort, path: '/api/floyd/experience/stream' }, (response) => {
        response.once('data', (chunk) => {
          assert.match(chunk.toString(), /event: experience/);
          request.destroy();
          resolve();
        });
      });
      request.once('error', (error) => {
        if (error.code !== 'ECONNRESET') reject(error);
      });
    });
    const streamAbortDeadline = Date.now() + 2_000;
    while (!experienceStreamClosed && Date.now() < streamAbortDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(experienceStreamClosed, true, 'browser disconnect cancels the Core Experience stream');

    mode = 'unauthorized';
    const denied = await get(surfacePort, '/api/floyd/health');
    assert.equal(denied.status, 401);
    assert.deepEqual(JSON.parse(denied.body), { error: { type: 'auth', message: 'exact upstream auth failure' } });
    const deniedStream = await get(surfacePort, '/api/floyd/experience/stream');
    assert.equal(deniedStream.status, 401);
    assert.deepEqual(JSON.parse(deniedStream.body), { error: { type: 'auth', message: 'exact upstream auth failure' } });

    mode = 'delay';
    delayedStarted = new Promise((resolve) => { resolveDelayedStarted = resolve; });
    const abandoned = http.get({ hostname: '127.0.0.1', port: surfacePort, path: '/api/floyd/health' });
    abandoned.on('error', () => {});
    await delayedStarted;
    abandoned.destroy();
    const abortDeadline = Date.now() + 2_000;
    while (!upstreamClosed && Date.now() < abortDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(upstreamClosed, true, 'client disconnect aborts the Core request');
    mode = 'ok';

    mode = 'wrong-project';
    await new Promise((resolve, reject) => {
      let socket;
      const timer = setTimeout(() => reject(new Error('wrong-project launch did not fail closed')), 15_000);
      createTestWebSocket(surfacePort).then((created) => {
        socket = created;
        socket.on('open', () => socket.send(JSON.stringify({ type: 'shell', cols: 100, rows: 30 })));
        socket.on('message', (raw) => {
          const message = JSON.parse(raw.toString());
          if (message.type === 'ready') socket.send(JSON.stringify({ type: 'floyd' }));
          if (message.type === 'floyd-ready') reject(new Error('wrong-project launch was acknowledged'));
          if (message.type === 'error' && message.code === 'FLOYD_LAUNCH_FAILED') {
            clearTimeout(timer);
            assert.match(message.message, /project is absent from Core state/);
            socket.send(JSON.stringify({ type: 'close' }));
            socket.close();
            resolve();
          }
        });
        socket.on('error', reject);
      }).catch(reject);
    });

    mode = 'missing-context';
    await new Promise((resolve, reject) => {
      let socket;
      const timer = setTimeout(() => reject(new Error('missing-context launch did not fail closed')), 15_000);
      createTestWebSocket(surfacePort).then((created) => {
        socket = created;
        socket.on('open', () => socket.send(JSON.stringify({ type: 'shell', cols: 100, rows: 30 })));
        socket.on('message', (raw) => {
          const message = JSON.parse(raw.toString());
          if (message.type === 'ready') socket.send(JSON.stringify({ type: 'floyd' }));
          if (message.type === 'floyd-ready') reject(new Error('missing-context launch was acknowledged'));
          if (message.type === 'error' && message.code === 'FLOYD_LAUNCH_FAILED') {
            clearTimeout(timer);
            assert.match(message.message, /invalid Floyd session ID/);
            socket.send(JSON.stringify({ type: 'close' }));
            socket.close();
            resolve();
          }
        });
        socket.on('error', reject);
      }).catch(reject);
    });

    mode = 'ok';
    await new Promise((resolve, reject) => {
      let socket;
      let ready = false;
      let acknowledged = false;
      let output = '';
      const timer = setTimeout(() => reject(new Error(`TerminalOne Floyd PTY timed out: ${output}`)), 15_000);
      createTestWebSocket(surfacePort).then((created) => {
        socket = created;
        socket.on('open', () => socket.send(JSON.stringify({ type: 'shell', cols: 100, rows: 30 })));
        socket.on('message', (raw) => {
          const message = JSON.parse(raw.toString());
          if (message.type === 'ready' && !ready) {
            ready = true;
            socket.send(JSON.stringify({ type: 'floyd' }));
          } else if (message.type === 'floyd-ready') {
            acknowledged = message.projectId === 'project-1';
          } else if (message.type === 'output') {
            output += message.data;
          } else if (message.type === 'error') {
            clearTimeout(timer);
            reject(new Error(`${message.code}: ${message.message}`));
          }
          if (acknowledged
            && output.includes(`FLOYD_TUI_CWD:${projectRoot}`)
            && output.includes('FLOYD_TUI_LAUNCHED:floyd --project-id project-1 --session session-1 --run run-1 --event 21')) {
            clearTimeout(timer);
            socket.send(JSON.stringify({ type: 'close' }));
            socket.close();
            resolve();
          }
        });
        socket.on('error', reject);
      }).catch(reject);
    });

    console.log('PASS TerminalOne ticket gate, exact Floyd project/session/run/event handoff, missing-context and wrong-project rejection, stream abort, and exact errors');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await close(fakeCore);
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
