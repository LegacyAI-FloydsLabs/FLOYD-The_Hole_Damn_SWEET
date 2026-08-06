// @vitest-environment node
// === Tests: server/cursem-control.mjs (in-shell CLI control plane) =========
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createControlPlane } from '../server/cursem-control.mjs';
import { DEFAULT_CLI_SETTINGS } from '../server/cursem-permissions.mjs';

const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cursem-control-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/main.ts'), 'export const value = 1;\n');
  const settingsPath = join(root, 'settings.json');
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/control/')) return void control.handle(req, res);
    res.writeHead(404).end();
  });
  const control = createControlPlane({
    server,
    getWorkspaceRoot: () => root,
    settingsPath,
    forwardTimeoutMs: 250,
    ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  cleanups.push(async () => {
    control.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const invoke = (method, args = {}, headers = {}) => fetch(`http://127.0.0.1:${port}/api/control/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${control.token}`, ...headers },
    body: JSON.stringify({ method, args }),
  });
  return { root, port, control, invoke, settingsPath };
}

describe('cursem control plane', () => {
  it('rejects invoke without the bearer token', async () => {
    const { port } = await fixture();
    const response = await fetch(`http://127.0.0.1:${port}/api/control/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'cursem.version', args: {} }),
    });
    expect(response.status).toBe(401);
  });

  it('answers cursem.version in place', async () => {
    const { invoke } = await fixture();
    const body = await (await invoke('cursem.version')).json();
    expect(body).toEqual({ result: { version: 1 } });
  });

  it('rejects unknown methods as unsupported before any gate', async () => {
    const { invoke } = await fixture();
    const body = await (await invoke('cursem.terminal.frobnicate')).json();
    expect(body.error.code).toBe('unsupported');
  });

  it('denies terminal input by default, naming the exact setting', async () => {
    const { invoke } = await fixture();
    const body = await (await invoke('cursem.terminal.type', { targetId: 'terminal:x', text: 'ls' })).json();
    expect(body.error.code).toBe('permission-denied');
    expect(body.error.setting).toBe('cliTerminalInputEnabled');
    expect(body.error.message).toContain('cliTerminalInputEnabled');
  });

  it('fails closed when the master switch is off, and recovers when re-enabled', async () => {
    const { port, control, invoke } = await fixture();
    const put = (settings) => fetch(`http://127.0.0.1:${port}/api/control/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${control.token}` },
      body: JSON.stringify({ settings }),
    });
    await put({ cliEnabled: false });
    let body = await (await invoke('cursem.version')).json();
    expect(body.error.code).toBe('cli-disabled');
    await put({ cliEnabled: true });
    body = await (await invoke('cursem.version')).json();
    expect(body.result.version).toBe(1);
  });

  it('reports executor-unavailable when no renderer is connected', async () => {
    const { invoke } = await fixture();
    const body = await (await invoke('cursem.terminal.read', {})).json();
    expect(body.error.code).toBe('executor-unavailable');
  });

  it('serves and persists the permission settings matrix', async () => {
    const { port, control, settingsPath } = await fixture();
    const headers = { authorization: `Bearer ${control.token}` };
    const get = () => fetch(`http://127.0.0.1:${port}/api/control/settings`, { headers });
    let body = await (await get()).json();
    expect(body.settings).toEqual(DEFAULT_CLI_SETTINGS);
    expect(body.matrix.map((row) => row.id)).toEqual(['terminal', 'surface', 'editor', 'notifications']);

    const put = await fetch(`http://127.0.0.1:${port}/api/control/settings`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { cliTerminalInputEnabled: true, bogusKey: true } }),
    });
    body = await put.json();
    expect(body.settings.cliTerminalInputEnabled).toBe(true);
    expect('bogusKey' in body.settings).toBe(false);

    const persisted = JSON.parse(await readFile(settingsPath, 'utf8'));
    expect(persisted.cliTerminalInputEnabled).toBe(true);

    // A fresh plane over the same file loads the persisted values.
    const secondServer = http.createServer((req, res) => void second.handle(req, res));
    const second = createControlPlane({ server: secondServer, getWorkspaceRoot: () => '/', settingsPath });
    cleanups.push(async () => { second.close(); await new Promise((resolve) => secondServer.close(resolve)); });
    expect(second.settings.cliTerminalInputEnabled).toBe(true);
  });

  it('requires the bearer token on the settings routes too', async () => {
    const { port } = await fixture();
    const response = await fetch(`http://127.0.0.1:${port}/api/control/settings`);
    expect(response.status).toBe(401);
  });

  it('confines editor.openFile to existing files inside the workspace', async () => {
    const { invoke, root } = await fixture();
    let body = await (await invoke('cursem.editor.openFile', { path: '/etc/passwd' })).json();
    expect(body.error.code).toBe('path-escapes-workspace');
    body = await (await invoke('cursem.editor.openFile', { path: 'src/missing.ts' })).json();
    expect(body.error.code).toBe('no-such-file');
    body = await (await invoke('cursem.editor.openFile', { path: 'src' })).json();
    expect(body.error.code).toBe('not-a-file');
    // Valid file passes confinement and reaches the (absent) executor.
    body = await (await invoke('cursem.editor.openFile', { path: 'src/main.ts', line: '2' })).json();
    expect(body.error.code).toBe('executor-unavailable');
    body = await (await invoke('cursem.editor.openFile', { path: `${root}/src/main.ts` })).json();
    expect(body.error.code).toBe('executor-unavailable');
  });

  it('delivers the token over the same-origin WS handshake and forwards invokes', async () => {
    const { port, control, invoke } = await fixture();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/control/ws`, ['cursem-control'], {
      headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` },
    });
    const hello = await new Promise((resolve, reject) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data))));
      ws.once('error', reject);
    });
    expect(hello.type).toBe('hello');
    expect(hello.token).toBe(control.token);
    expect(hello.api).toBe(`http://127.0.0.1:${port}/api/control`);

    // Invoke forwards to the renderer executor and awaits its reply.
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (typeof msg.requestId === 'number') {
        expect(msg.method).toBe('cursem.terminal.read');
        ws.send(JSON.stringify({ requestId: msg.requestId, ok: true, result: { text: 'screen text' } }));
      }
    });
    const body = await (await invoke('cursem.terminal.read', {})).json();
    expect(body).toEqual({ result: { text: 'screen text' } });
    ws.close();
  });

  it('times out forwarded invokes when the renderer never replies', async () => {
    const { port, invoke } = await fixture();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/control/ws`, ['cursem-control'], {
      headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` },
    });
    await new Promise((resolve) => ws.once('message', resolve)); // hello
    const body = await (await invoke('cursem.surface.list', {})).json();
    expect(body.error.code).toBe('executor-timeout');
    ws.close();
  });

  it('rejects control WS upgrades from foreign origins', async () => {
    const { port } = await fixture();
    await expect(new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/control/ws`, ['cursem-control'], {
        headers: { origin: 'http://evil.example.com', host: `127.0.0.1:${port}` },
      });
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    })).rejects.toThrow();
  });
});
