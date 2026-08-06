// @vitest-environment node
// Thread delete: agent-store cascade semantics + the standalone host's
// DELETE /api/agent/thread route the chat session sidebar now calls.
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentStore } from '../server/agent-store.mjs';
import { createStandaloneHost } from '../server/standalone-host.mjs';

const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function storeFixture() {
  const databasePath = join(tmpdir(), `cursem-store-del-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const store = createAgentStore({ workspaceRoot: tmpdir(), databasePath });
  cleanups.push(async () => store.close());
  return store;
}

async function hostFixture() {
  const root = await mkdtemp(join(tmpdir(), 'cursem-del-'));
  const agentStore = createAgentStore({
    workspaceRoot: root,
    databasePath: join(tmpdir(), `cursem-del-${Date.now()}.sqlite`),
  });
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const host = await createStandaloneHost({
    initialWorkspaceRoot: root,
    terminalEndpoint: 'ws://127.0.0.1:41000',
    terminalToken: 'local-token',
    agentStore,
  });
  server.on('request', (req, res) => void host.handle(req, res));
  cleanups.push(async () => {
    host.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { base, agentStore };
}

describe('agent store thread delete', () => {
  it('removes the thread and cascades messages, runs, and run events', () => {
    const store = storeFixture();
    const thread = store.createThread('delete me');
    store.addMessage(thread.id, 'user', 'hello');
    const run = store.createRun({ threadId: thread.id, provider: 'p', model: 'm' });
    store.appendEvent(run.id, 'tool_begin', { id: 't1', name: 'search' });

    expect(store.deleteThread(thread.id)).toBe(true);
    expect(store.getThread(thread.id)).toBeNull();
    expect(store.getRun(run.id)).toBeNull();
    expect(store.listThreads()).toHaveLength(0);
  });

  it('returns false for an unknown thread', () => {
    const store = storeFixture();
    expect(store.deleteThread('no-such-thread')).toBe(false);
  });
});

describe('DELETE /api/agent/thread', () => {
  it('deletes an existing thread and 404s on a repeat delete', async () => {
    const { base, agentStore } = await hostFixture();
    const thread = agentStore.createThread('via http');

    const deleted = await fetch(`${base}/api/agent/thread?id=${encodeURIComponent(thread.id)}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(agentStore.getThread(thread.id)).toBeNull();

    const repeat = await fetch(`${base}/api/agent/thread?id=${encodeURIComponent(thread.id)}`, { method: 'DELETE' });
    expect(repeat.status).toBe(404);
  });
});
