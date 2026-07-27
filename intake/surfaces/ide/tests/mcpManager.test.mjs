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
  if (message.method === 'tools/call') result = { content: [{ type: 'text', text: String(message.params.arguments.value) }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});`);
    cleanups.push(() => rm(scriptRoot, { recursive: true, force: true }));
    const root = await rootFixture({ fixture: { command: process.execPath, args: [script], env: { SECRET_TOKEN: 'redacted-value' } } });
    const manager = createMcpManager({ workspaceRoot: root }); cleanups.push(async () => manager.close());
    expect(await manager.list()).toEqual([expect.objectContaining({ id: 'fixture', transport: 'stdio', envKeys: ['SECRET_TOKEN'], status: 'disconnected' })]);
    await expect(manager.tools('fixture')).rejects.toMatchObject({ status: 409 });
    await expect(manager.connect('fixture')).resolves.toMatchObject({ status: 'connected', transport: 'stdio', pid: expect.any(Number) });
    await expect(manager.tools('fixture')).resolves.toEqual([expect.objectContaining({ name: 'echo' })]);
    await expect(manager.call('fixture', 'echo', { value: 'hello' })).resolves.toEqual({ content: [{ type: 'text', text: 'hello' }] });
    expect(JSON.stringify(await manager.list())).not.toContain('redacted-value');
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
    const manager = createMcpManager({ workspaceRoot: root }); cleanups.push(async () => manager.close());
    await manager.connect('remote');
    expect(await manager.tools('remote')).toEqual([{ name: 'ping' }]);
    expect(await manager.call('remote', 'ping', {})).toEqual({ content: [{ type: 'text', text: 'pong' }] });
  });
});
