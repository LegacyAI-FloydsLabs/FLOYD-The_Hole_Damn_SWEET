// @vitest-environment node
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentStore } from '../server/agent-store.mjs';
import { createStandaloneHost } from '../server/standalone-host.mjs';

const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cursem-hooks-'));
  await writeFile(join(root, 'README.md'), '# test\n');
  const hooksDir = await mkdtemp(join(tmpdir(), 'cursem-hooksdir-'));
  const agentStore = createAgentStore({
    workspaceRoot: root,
    databasePath: join(tmpdir(), `cursem-hooks-${Date.now()}.sqlite`),
  });

  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const host = await createStandaloneHost({
    initialWorkspaceRoot: root,
    terminalEndpoint: 'ws://127.0.0.1:41000',
    terminalToken: 'local-token',
    agentStore,
    agentHooksOrigin: () => base,
    agentHooksDir: hooksDir,
    agentHooksHome: hooksDir,
  });
  server.on('request', (req, res) => void host.handle(req, res));

  cleanups.push(async () => {
    host.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    await rm(hooksDir, { recursive: true, force: true });
  });

  return { root, base };
}

describe('agent-aware terminal hooks integration', () => {
  it('mints a terminal id and hook env at terminal auth time', async () => {
    const { base } = await fixture();
    const auth = await fetch(`${base}/api/terminal/auth`).then((r) => r.json());
    expect(auth.endpoint).toBe('ws://127.0.0.1:41000');
    expect(auth.token).toBe('local-token');
    expect(typeof auth.terminalId).toBe('string');
    expect(auth.terminalId.length).toBeGreaterThan(0);
    expect(auth.terminalEnv).toMatchObject({
      CURSEM_HOOK_ENDPOINT: `${base}/api/agent-hooks`,
      CURSEM_TERMINAL_ID: auth.terminalId,
    });
    expect(typeof auth.terminalEnv.CURSEM_HOOK_TOKEN).toBe('string');
    expect(auth.terminalEnv.CURSEM_HOOK_TOKEN.length).toBeGreaterThan(0);
  });

  it('accepts a hook post, stores a stamp, and reports presence', async () => {
    const { base } = await fixture();
    const auth = await fetch(`${base}/api/terminal/auth`).then((r) => r.json());
    const token = auth.terminalEnv.CURSEM_HOOK_TOKEN;

    const post = await fetch(`${base}/api/agent-hooks/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        agentId: 'claude-code',
        terminalId: auth.terminalId,
        pid: process.pid,
        payload: {
          hook_event_name: 'UserPromptSubmit',
          session_id: 'ses-test-1',
          cwd: '/repo',
          transcript_path: '/repo/transcript.jsonl',
        },
      }),
    });
    expect(post.status).toBe(204);

    const stamps = await fetch(`${base}/api/agent-hooks/stamps`).then((r) => r.json());
    expect(stamps.stamps).toContainEqual(expect.objectContaining({
      terminalId: auth.terminalId,
      agentId: 'claude-code',
      sessionId: 'ses-test-1',
    }));

    // Presence is derived from a process-table walk that requires a matching
    // agent binary in the reported pid's ancestry; the Node test runner does not
    // look like claude/codex, so presence remains empty here. The stamp is the
    // durable resumability signal.
    const presence = await fetch(`${base}/api/agent-hooks/presence`).then((r) => r.json());
    expect(Array.isArray(presence.presence)).toBe(true);
  });

  it('rejects a hook post with a bad token', async () => {
    const { base } = await fixture();
    const auth = await fetch(`${base}/api/terminal/auth`).then((r) => r.json());
    const post = await fetch(`${base}/api/agent-hooks/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer bad-token' },
      body: JSON.stringify({
        agentId: 'claude-code',
        terminalId: auth.terminalId,
        pid: process.pid,
        payload: { hook_event_name: 'Stop', session_id: 's' },
      }),
    });
    expect(post.status).toBe(401);
  });

  it('streams hook events through SSE', async () => {
    const { base } = await fixture();
    const auth = await fetch(`${base}/api/terminal/auth`).then((r) => r.json());
    const token = auth.terminalEnv.CURSEM_HOOK_TOKEN;

    const messages = [];
    let buffer = '';
    const req = http.get(`${base}/api/agent-hooks/events`, (res) => {
      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop();
        for (const block of blocks) {
          const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
          if (dataLine) messages.push(JSON.parse(dataLine.slice('data: '.length)));
        }
      });
    });

    await new Promise((resolve, reject) => {
      const check = () => {
        if (messages.length >= 2) return resolve();
        setTimeout(check, 20);
      };
      req.on('error', reject);
      setTimeout(check, 50);
    });

    // Initial presence + stamps snapshots.
    expect(messages[0]).toMatchObject({ type: 'presence', snapshot: [] });
    expect(messages[1]).toMatchObject({ type: 'stamps', snapshot: [] });

    await fetch(`${base}/api/agent-hooks/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        agentId: 'claude-code',
        terminalId: auth.terminalId,
        pid: process.pid,
        payload: { hook_event_name: 'Stop', session_id: 's1', cwd: '/repo' },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    req.destroy();

    const eventMsg = messages.find((m) => m.type === 'hook');
    expect(eventMsg).toMatchObject({
      type: 'hook',
      event: expect.objectContaining({ agentId: 'claude-code', kind: 'turn-end', sessionId: 's1' }),
    });
  });
});
