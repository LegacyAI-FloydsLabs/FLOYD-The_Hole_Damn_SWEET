// @vitest-environment node
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStandaloneHost } from '../server/standalone-host.mjs';

const cleanups = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function start(root, databasePath) {
  const host = await createStandaloneHost({ initialWorkspaceRoot: root, agentDatabasePath: databasePath });
  const server = http.createServer((req, res) => { void host.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    host.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  };
  return { base, close };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cursem-agent-'));
  const state = await mkdtemp(join(tmpdir(), 'cursem-state-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/main.ts'), 'export const value = 1;\n');
  const databasePath = join(state, 'state.sqlite');
  cleanups.push(() => rm(root, { recursive: true, force: true }), () => rm(state, { recursive: true, force: true }));
  return { root, databasePath };
}

async function json(base, path, body) {
  const response = await fetch(`${base}${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

describe('durable agent runtime', () => {
  it('persists threads, messages, runs, and ordered evidence across restart', async () => {
    const { root, databasePath } = await fixture();
    const first = await start(root, databasePath);
    const thread = (await json(first.base, '/api/agent/threads', { title: 'Implement parser' })).payload;
    await json(first.base, '/api/agent/messages', { threadId: thread.id, role: 'user', content: 'Build it', metadata: { source: 'test' } });
    const run = (await json(first.base, '/api/agent/runs', { threadId: thread.id, provider: 'opencode-go', model: 'test-model' })).payload;
    await json(first.base, '/api/agent/events', { runId: run.id, type: 'tool.started', payload: { tool: 'search' } });
    await json(first.base, '/api/agent/events', { runId: run.id, type: 'tool.completed', payload: { matches: 2 } });
    await json(first.base, '/api/agent/run/update', { runId: run.id, status: 'completed', summary: { tests: 'pass' } });
    await first.close();

    const second = await start(root, databasePath);
    const loaded = await fetch(`${second.base}/api/agent/thread?id=${thread.id}`).then((response) => response.json());
    const loadedRun = await fetch(`${second.base}/api/agent/run?id=${run.id}`).then((response) => response.json());
    expect(loaded.messages).toEqual([expect.objectContaining({ role: 'user', content: 'Build it', metadata: { source: 'test' } })]);
    expect(loaded.runs[0]).toMatchObject({ status: 'completed', summary: { tests: 'pass' } });
    expect(loadedRun.events.map((event) => [event.sequence, event.type])).toEqual([[1, 'tool.started'], [2, 'tool.completed']]);
    await second.close();
  });

  it('applies a reviewed multi-file transaction and restores its durable checkpoint', async () => {
    const { root, databasePath } = await fixture();
    const host = await start(root, databasePath);
    const preview = (await json(host.base, '/api/agent/patch/preview', {
      changes: [
        { path: 'src/main.ts', content: 'export const value = 2;\n' },
        { path: 'src/nested/new.ts', content: 'export const added = true;\n' },
      ],
    })).payload;
    expect(preview.files).toEqual([
      expect.objectContaining({ path: 'src/main.ts', operation: 'modify' }),
      expect.objectContaining({ path: 'src/nested/new.ts', operation: 'create' }),
    ]);
    const applied = (await json(host.base, '/api/agent/patch/apply', { proposalId: preview.proposalId, label: 'two-file edit' })).payload;
    expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toContain('value = 2');
    expect(await readFile(join(root, 'src/nested/new.ts'), 'utf8')).toContain('added = true');
    const checkpoints = await fetch(`${host.base}/api/agent/checkpoints`).then((response) => response.json());
    expect(checkpoints.checkpoints[0]).toMatchObject({ id: applied.checkpointId, label: 'two-file edit' });
    await host.close();

    const restarted = await start(root, databasePath);
    const restored = await json(restarted.base, '/api/agent/checkpoints/restore', { checkpointId: applied.checkpointId });
    expect(restored.response.status).toBe(200);
    expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toContain('value = 1');
    await expect(readFile(join(root, 'src/nested/new.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await restarted.close();
  });

  it('rejects stale proposals without overwriting a newer disk edit', async () => {
    const { root, databasePath } = await fixture();
    const host = await start(root, databasePath);
    const preview = (await json(host.base, '/api/agent/patch/preview', {
      changes: [{ path: 'src/main.ts', content: 'export const value = 2;\n' }],
    })).payload;
    await writeFile(join(root, 'src/main.ts'), 'export const value = 99;\n');
    const apply = await json(host.base, '/api/agent/patch/apply', { proposalId: preview.proposalId });
    expect(apply.response.status).toBe(409);
    expect(apply.payload.error.message).toContain('changed after the proposal');
    expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toContain('value = 99');
    await host.close();
  });

  it('applies only explicitly selected review hunks', async () => {
    const { root, databasePath } = await fixture();
    await writeFile(join(root, 'src/main.ts'), 'first\nkeep\nthird\n');
    const host = await start(root, databasePath);
    const preview = (await json(host.base, '/api/agent/patch/preview', {
      changes: [{ path: 'src/main.ts', content: 'FIRST\nkeep\nTHIRD\n' }],
    })).payload;
    expect(preview.files[0].hunks).toHaveLength(2);
    const firstHunk = preview.files[0].hunks[0].id;
    const applied = await json(host.base, '/api/agent/patch/apply', {
      proposalId: preview.proposalId,
      acceptedPaths: ['src/main.ts'],
      acceptedHunks: { 'src/main.ts': [firstHunk] },
    });
    expect(applied.response.status).toBe(200);
    expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toBe('FIRST\nkeep\nthird\n');
    await host.close();
  });

  it('stores project memory only after an explicit save and supports deletion', async () => {
    const { root, databasePath } = await fixture();
    const first = await start(root, databasePath);
    expect((await fetch(`${first.base}/api/agent/memories`).then((response) => response.json())).memories).toEqual([]);
    const saved = await json(first.base, '/api/agent/memories', { content: 'Always use strict TypeScript.' });
    expect(saved.payload).toMatchObject({ content: 'Always use strict TypeScript.', source: 'user-approved' });
    await first.close();
    const second = await start(root, databasePath);
    expect((await fetch(`${second.base}/api/agent/memories`).then((response) => response.json())).memories).toEqual([expect.objectContaining({ id: saved.payload.id })]);
    const removed = await fetch(`${second.base}/api/agent/memories?id=${saved.payload.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect((await fetch(`${second.base}/api/agent/memories`).then((response) => response.json())).memories).toEqual([]);
    await second.close();
  });
});
