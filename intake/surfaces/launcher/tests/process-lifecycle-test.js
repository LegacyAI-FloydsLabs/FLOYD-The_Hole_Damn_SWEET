#!/usr/bin/env node
'use strict';

const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const PORT = 11015;
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: ['ignore', 'ignore', 'inherit'],
});

function waitForHealth() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const probe = () => {
      const request = http.get(`${BASE}/health`, (response) => {
        response.resume();
        if (response.statusCode === 200) return resolve();
        retry();
      });
      request.on('error', retry);
    };
    const retry = () => {
      if (Date.now() - started > 10_000) return reject(new Error('launcher did not become healthy'));
      setTimeout(probe, 100);
    };
    probe();
  });
}

async function main() {
  try {
    await waitForHealth();
    const result = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const timer = setTimeout(() => reject(new Error('no command-exit event within 15 seconds')), 15_000);
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'launch',
          harness: 'code-planner',
          args: ['--help'],
          cols: 100,
          rows: 30,
        }));
      });
      ws.on('message', (raw) => {
        const message = JSON.parse(raw);
        if (message.type !== 'command-exit') return;
        clearTimeout(timer);
        ws.send(JSON.stringify({ type: 'close' }));
        ws.close();
        resolve(message);
      });
      ws.on('error', reject);
    });
    if (result.harness !== 'code-planner' || result.code !== 0) {
      throw new Error(`unexpected lifecycle event: ${JSON.stringify(result)}`);
    }
    console.log(`PASS process lifecycle: ${result.harness} emitted command-exit code=${result.code}`);
  } finally {
    child.kill('SIGTERM');
  }
}

main().catch((error) => {
  child.kill('SIGTERM');
  console.error(error);
  process.exitCode = 1;
});
