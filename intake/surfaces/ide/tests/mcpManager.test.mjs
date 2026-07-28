// @vitest-environment node
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpManager } from '../server/mcp-manager.mjs';

const cleanups = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function rootFixture(config) {
  const root = await mkdtemp(join(tmpdir(), 'cursem-mcp-'));
  await mkdir(join(root, '.cursem'));
  await writeFile(join(root, '.cursem', 'mcp.json'), JSON.stringify({ mcpServers: config }));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe('MCP manager', () => {
  it('discovers redacted stdio configuration and executes protocol tools only after connection', async () => {
    const scriptRoot = await mkdtemp(join(tmpdir(), 'cursem-mcp-server-'));
    const script = join(scriptRoot, 'server.mjs');
    await writeFile(script, `import readline from 'node:readline';
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => { const message = JSON.parse(line); if (message.id === undefined) return;
  let result = {}; if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object' } }] };
  if (message.method === 'tools/call') {
    const value = message.params.arguments.value;
    result = { content: [{ type: 'text', text: value === 'env-proof' ? JSON.stringify({
      REAL_SECRET: process.env.REAL_SECRET,
      GITHUB_PAT: process.env.GITHUB_PAT,
      XYZ_TOKEN: process.env.XYZ_TOKEN,
      GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      AZURE_CLIENT_SECRET: process.env.AZURE_CLIENT_SECRET,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      GITHUB_BASE_URL: process.env.GITHUB_BASE_URL,
      GITHUB_ENDPOINT: process.env.GITHUB_ENDPOINT,
      GITHUB_API_URL: process.env.GITHUB_API_URL,
      LOG_LEVEL: process.env.LOG_LEVEL,
    }) : String(value) }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});`);
    cleanups.push(() => rm(scriptRoot, { recursive: true, force: true }));
    const root = await rootFixture({
      fixture: {
        command: process.execPath,
        args: [script],
        env: { LOG_LEVEL: 'info' },
        vaultEnv: {
          GITHUB_TOKEN: 'github',
          GITHUB_BASE_URL: 'github',
          GITHUB_ENDPOINT: 'github',
          GITHUB_API_URL: 'github',
        },
      },
    });
    const manager = createMcpManager({
      workspaceRoot: root,
      environment: {
        ...vaultEnvironment(),
        REAL_SECRET: 'machine-real-secret',
        GITHUB_PAT: 'github_pat_machine-real',
        XYZ_TOKEN: 'machine-real-token',
        GOOGLE_APPLICATION_CREDENTIALS: '/tmp/machine-real-service-account.json',
        AZURE_CLIENT_SECRET: 'machine-real-azure',
      },
    });
    cleanups.push(async () => manager.close());
    expect(await manager.list()).toEqual([expect.objectContaining({
      id: 'fixture', transport: 'stdio', envKeys: ['LOG_LEVEL'], status: 'disconnected',
    })]);
    await expect(manager.tools('fixture')).rejects.toMatchObject({ status: 409 });
    await expect(manager.connect('fixture')).resolves.toMatchObject({ status: 'connected', transport: 'stdio', pid: expect.any(Number) });
    await expect(manager.tools('fixture')).resolves.toEqual([expect.objectContaining({ name: 'echo' })]);
    await expect(manager.call('fixture', 'echo', { value: 'hello' })).resolves.toEqual({ content: [{ type: 'text', text: 'hello' }] });
    const proof = await manager.call('fixture', 'echo', { value: 'env-proof' });
    const childEnv = JSON.parse(proof.content[0].text);
    expect(childEnv).toEqual({
      GITHUB_TOKEN: VAULT_TOKEN,
      GITHUB_BASE_URL: 'http://127.0.0.1:13031/p/github',
      GITHUB_ENDPOINT: 'http://127.0.0.1:13031/p/github',
      GITHUB_API_URL: 'http://127.0.0.1:13031/p/github',
      LOG_LEVEL: 'info',
    });
    expect(JSON.stringify(await manager.list())).not.toContain('fv_');
  });

  it('supports loopback Streamable HTTP sessions', async () => {
    const server = http.createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = message.method === 'tools/list' ? { tools: [{ name: 'ping' }] }
        : message.method === 'tools/call' ? { content: [{ type: 'text', text: 'pong' }] }
          : { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'http', version: '1' } };
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    const root = await rootFixture({ remote: { url: `http://127.0.0.1:${server.address().port}` } });
    const manager = createMcpManager({ workspaceRoot: root, environment: vaultEnvironment() });
    await manager.connect('remote');
    expect(await manager.tools('remote')).toEqual([{ name: 'ping' }]);
    expect(await manager.call('remote', 'ping', {})).toEqual({ content: [{ type: 'text', text: 'pong' }] });
  });

  it('preserves authenticated remote MCP behavior through an fv_ Vault capability only', async () => {
    const seen = [];
    const vault = http.createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({ url: request.url, authorization: request.headers.authorization, method: message.method });
      const result = message.method === 'tools/list' ? { tools: [{ name: 'remote-search' }] }
        : message.method === 'tools/call' ? { content: [{ type: 'text', text: 'remote-result' }] }
          : { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'vault-mcp', version: '1' } };
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'vault-session' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    await new Promise((resolve) => vault.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise((resolve) => vault.close(resolve)));
    const root = await rootFixture({ remote: { vault: { target: 'private-search' } } });
    const manager = createMcpManager({
      workspaceRoot: root,
      environment: vaultEnvironment(vault.address().port),
    });
    cleanups.push(async () => manager.close());

    expect(await manager.list()).toEqual([expect.objectContaining({
      id: 'remote',
      transport: 'http',
      vaultTarget: 'private-search',
      url: `http://127.0.0.1:${vault.address().port}/mcp/private-search`,
    })]);
    await manager.connect('remote');
    expect(await manager.tools('remote')).toEqual([{ name: 'remote-search' }]);
    expect(await manager.call('remote', 'remote-search', {})).toEqual({
      content: [{ type: 'text', text: 'remote-result' }],
    });
    expect(seen).toEqual([
      expect.objectContaining({ url: '/mcp/private-search', authorization: `Bearer ${VAULT_TOKEN}`, method: 'initialize' }),
      expect.objectContaining({ url: '/mcp/private-search', authorization: `Bearer ${VAULT_TOKEN}`, method: 'tools/list' }),
      expect.objectContaining({ url: '/mcp/private-search', authorization: `Bearer ${VAULT_TOKEN}`, method: 'tools/call' }),
    ]);
    expect(JSON.stringify(await manager.list())).not.toMatch(/api\.example|real-secret|authorization/i);
  });

  it('rejects legacy direct remote URLs and secret-bearing MCP configuration', async () => {
    const remoteRoot = await rootFixture({
      remote: { url: 'https://private.example/mcp', headers: { authorization: 'Bearer real-secret' } },
    });
    const remote = createMcpManager({ workspaceRoot: remoteRoot, environment: vaultEnvironment() });
    cleanups.push(async () => remote.close());
    await expect(remote.list()).rejects.toMatchObject({ status: 409 });

    const stdioRoot = await rootFixture({
      remote: { command: process.execPath, env: { SERVICE_TOKEN: 'real-secret' } },
    });
    const stdio = createMcpManager({ workspaceRoot: stdioRoot, environment: vaultEnvironment() });
    cleanups.push(async () => stdio.close());
    await expect(stdio.list()).rejects.toMatchObject({ status: 409 });
  });
});

const VAULT_TOKEN = `fv_cursem_${'a'.repeat(32)}`;
function vaultEnvironment(port = 13031) {
  return {
    PATH: process.env.PATH,
    FLOYD_VAULT_PROXY_URL: `http://127.0.0.1:${port}`,
    FLOYD_VAULT_PROXY_TOKEN: VAULT_TOKEN,
  };
}
