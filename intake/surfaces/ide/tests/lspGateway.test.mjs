// @vitest-environment node
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { createLspGateway } from '../server/lsp-gateway.mjs';

describe('shared language-server gateway', () => {
  it('bridges browser JSON-RPC to one real TypeScript stdio language server', { timeout: 20_000 }, async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'cursem-lsp-'));
    await writeFile(join(workspace, 'index.ts'), 'export const answer = 42;\n');
    const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    const manager = createLspGateway({ server, workspaceRoot: workspace, appRoot: resolve('.') });
    await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const address = server.address();
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/lsp/typescript`);
    try {
      await new Promise((resolvePromise, reject) => { ws.once('open', resolvePromise); ws.once('error', reject); });
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { processId: null, rootUri: `file://${workspace}`, capabilities: {}, workspaceFolders: [{ uri: `file://${workspace}`, name: 'fixture' }] },
      }));
      const response = await new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new Error('LSP initialize timed out')), 15_000);
        ws.on('message', (raw) => {
          const message = JSON.parse(String(raw));
          if (message.id === 1) { clearTimeout(timer); resolvePromise(message); }
        });
      });
      expect(response).toMatchObject({ id: 1, result: { capabilities: expect.any(Object) } });
      expect(manager.health('typescript')).toMatchObject({ languageId: 'typescript', status: 'running' });
    } finally {
      ws.close();
      manager.close();
      server.closeAllConnections?.();
      await new Promise((resolvePromise) => server.close(resolvePromise));
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
