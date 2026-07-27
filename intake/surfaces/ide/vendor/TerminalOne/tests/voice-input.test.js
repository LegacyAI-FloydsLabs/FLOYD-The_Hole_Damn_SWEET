#!/usr/bin/env node
/**
 * Voice input protocol verification.
 *
 * Uses a temp mock `whisper` executable so the test proves TerminalOne's WS
 * framing, bounds, temp-file flow, and transcript response without downloading
 * a model or invoking real ASR.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = process.env.VOICE_PORT || 11005;
const BASE_URL = `http://localhost:${PORT}`;

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE_URL}${p}`, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });
}

async function waitForHealth(timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await get('/health');
      if (r.statusCode === 200 && JSON.parse(r.body).status === 'ok') return;
    } catch (_) {}
    if (Date.now() - start > timeoutMs) throw new Error('server did not become healthy');
    await new Promise((r) => setTimeout(r, 250));
  }
}

function openWs() {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws connect timeout')), 5000);
  });
}

function waitForMsg(ws, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timed out waiting for voice message')), timeoutMs);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (_) { return; }
      if (predicate(msg)) {
        clearTimeout(to);
        resolve(msg);
      }
    });
  });
}

function makeMockWhisper() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminalone-mock-whisper-'));
  const script = path.join(dir, 'mock-whisper');
  fs.writeFileSync(script, `#!/bin/sh
audio="$1"
outdir="."
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output_dir" ]; then
    shift
    outdir="$1"
  fi
  shift || break
done
base="$(basename "$audio")"
base="\${base%.*}"
printf 'git status.\\n' > "$outdir/$base.txt"
`, { mode: 0o755 });
  return { dir, script };
}

function assertLog(ok, msg) {
  assert.ok(ok, msg);
  console.log('  ✓ ' + msg);
}

async function run() {
  console.log('TerminalOne voice input protocol test');
  const mock = makeMockWhisper();
  const server = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), TERMINALONE_STT_BIN: mock.script, TERMINALONE_STT_TIMEOUT_MS: '8000' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });

  try {
    await waitForHealth();

    const ws = await openWs();
    ws.send(JSON.stringify({ type: 'voice-start', mimeType: 'audio/webm' }));
    const ready = await waitForMsg(ws, (m) => m.type === 'voice-ready');
    assertLog(ready.type === 'voice-ready', 'voice-start returns voice-ready');
    ws.send(JSON.stringify({ type: 'voice-chunk', b64: Buffer.from('fake audio').toString('base64') }));
    ws.send(JSON.stringify({ type: 'voice-end' }));
    const transcript = await waitForMsg(ws, (m) => m.type === 'voice-transcript');
    assertLog(transcript.text === 'git status.', `voice-end returns transcript (${transcript.text})`);
    ws.close();

    const ws2 = await openWs();
    ws2.send(JSON.stringify({ type: 'voice-start', mimeType: 'audio/webm' }));
    await waitForMsg(ws2, (m) => m.type === 'voice-ready');
    ws2.send(JSON.stringify({ type: 'voice-chunk', b64: Buffer.alloc(513 * 1024).toString('base64') }));
    const tooLarge = await waitForMsg(ws2, (m) => m.type === 'voice-error');
    assertLog(tooLarge.code === 'VOICE_CHUNK_TOO_LARGE', `oversized chunk rejected (${tooLarge.code})`);
    ws2.close();
  } catch (err) {
    console.error('\n✗ ' + (err && err.message ? err.message : err));
    if (log.trim()) console.error('--- server log ---\n' + log.trim());
    server.kill('SIGTERM');
    fs.rmSync(mock.dir, { recursive: true, force: true });
    process.exit(1);
  }

  server.kill('SIGTERM');
  fs.rmSync(mock.dir, { recursive: true, force: true });
  console.log('\nAll voice input protocol checks passed!');
}

run();
