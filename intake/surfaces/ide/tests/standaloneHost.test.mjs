// @vitest-environment node
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createStandaloneHost } from '../server/standalone-host.mjs';

const execFileAsync = promisify(execFile);
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture(options = {}) {
  // Canonicalize like the host does (macOS /var → /private/var) so path
  // assertions compare canonical-to-canonical.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cursem-host-')));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/main.ts'), 'export const value = 1;\n');
  const host = await createStandaloneHost({ initialWorkspaceRoot: root, terminalEndpoint: 'ws://127.0.0.1:41000', terminalToken: 'local-token', ...options });
  const server = http.createServer((req, res) => { void host.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    host.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, base };
}

describe('standalone trusted host', () => {
  it('reads, writes, lists, and reports the real approved workspace', async () => {
    const { root, base } = await fixture();
    const workspace = await fetch(`${base}/api/platform/workspace`).then((response) => response.json());
    expect(workspace.root).toBe(root);
    const read = await fetch(`${base}/api/fs/read?path=${encodeURIComponent(join(root, 'src/main.ts'))}`).then((response) => response.json());
    expect(read.content).toContain('value = 1');
    const writeResponse = await fetch(`${base}/api/fs/write`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: join(root, 'src/main.ts'), content: 'export const value = 2;\n' }) });
    expect(writeResponse.status).toBe(200);
    expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toContain('value = 2');
    const listing = await fetch(`${base}/api/fs/list?path=${encodeURIComponent(join(root, 'src'))}`).then((response) => response.json());
    expect(listing.items).toEqual([expect.objectContaining({ name: 'main.ts', type: 'file' })]);
  });

  it('rejects traversal and symlink escapes at the server boundary', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cursem-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'not in workspace');
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    const { root, base } = await fixture();
    await symlink(outside, join(root, 'outside-link'));
    const traversal = await fetch(`${base}/api/fs/read?path=${encodeURIComponent(join(root, '../outside.txt'))}`);
    expect(traversal.status).toBe(403);
    const escaped = await fetch(`${base}/api/fs/read?path=${encodeURIComponent(join(root, 'outside-link/secret.txt'))}`);
    expect(escaped.status).toBe(403);
  });

  it('lists a directory containing a broken symlink and reports symlinked dirs as browsable', async () => {
    const { root, base } = await fixture();
    await mkdir(join(root, 'real-dir'));
    await symlink(join(root, 'missing-target'), join(root, 'broken-link'));
    await symlink(join(root, 'real-dir'), join(root, 'dir-link'));
    const response = await fetch(`${base}/api/fs/list?path=${encodeURIComponent(root)}`);
    expect(response.status).toBe(200);
    const listing = await response.json();
    expect(listing.items).toContainEqual(expect.objectContaining({ name: 'broken-link', type: 'symlink', size: 0, mtimeMs: 0 }));
    expect(listing.items).toContainEqual(expect.objectContaining({ name: 'dir-link', type: 'dir' }));
  });

  it('uses fixed Git operations against the real system repository', async () => {
    const { root, base } = await fixture();
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['-c', 'user.name=CURSEM Test', '-c', 'user.email=cursem@example.invalid', 'commit', '-m', 'initial'], { cwd: root });
    await writeFile(join(root, 'src/main.ts'), 'export const value = 3;\n');
    const status = await fetch(`${base}/api/git/status?path=${encodeURIComponent(root)}`).then((response) => response.json());
    expect(status.clean).toBe(false);
    expect(status.changedFiles).toContainEqual(expect.objectContaining({ path: 'src/main.ts', status: 'modified' }));
    const staged = await fetch(`${base}/api/git/stage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repoPath: root, files: ['src/main.ts'] }) });
    expect(staged.status).toBe(200);
    const stagedStatus = await fetch(`${base}/api/git/status?path=${encodeURIComponent(root)}`).then((response) => response.json());
    expect(stagedStatus.changedFiles[0].staged).toBe(true);
  });

  it('reports Proofline governance and rejects raw commit and push', async () => {
    const { root, base } = await fixture();
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['-c', 'user.name=CURSEM Test', '-c', 'user.email=cursem@example.invalid', 'commit', '-m', 'initial'], { cwd: root });
    await writeFile(join(root, '.proofline.json'), '{"version":1}\n');
    await writeFile(join(root, 'src/main.ts'), 'export const value = 4;\n');
    await execFileAsync('git', ['add', 'src/main.ts'], { cwd: root });

    const status = await fetch(`${base}/api/git/status?path=${encodeURIComponent(root)}`).then((response) => response.json());
    expect(status.prooflineGoverned).toBe(true);

    const commit = await fetch(`${base}/api/git/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: root, message: 'unsafe raw commit' }),
    });
    expect(commit.status).toBe(403);
    await expect(commit.json()).resolves.toMatchObject({ error: { message: expect.stringContaining('Proofline') } });

    const push = await fetch(`${base}/api/git/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: root }),
    });
    expect(push.status).toBe(403);
    await expect(push.json()).resolves.toMatchObject({ error: { message: expect.stringContaining('session-end') } });

    const log = await execFileAsync('git', ['log', '-1', '--format=%s'], { cwd: root });
    expect(log.stdout.trim()).toBe('initial');
  });

  it('returns only short-lived local terminal authorization', async () => {
    const { base } = await fixture();
    const auth = await fetch(`${base}/api/terminal/auth`).then((response) => response.json());
    expect(auth).toMatchObject({ endpoint: 'ws://127.0.0.1:41000', token: 'local-token' });
    expect(auth.expiresAt).toBeGreaterThan(Date.now());
  });

  it('serves binary file bytes as base64 with a mime hint', async () => {
    const { root, base } = await fixture();
    await writeFile(join(root, 'pixel.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
    const response = await fetch(`${base}/api/fs/read-binary?path=${encodeURIComponent(join(root, 'pixel.png'))}`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.name).toBe('pixel.png');
    expect(payload.size).toBe(8);
    expect(payload.mime).toBe('image/png');
    expect(Buffer.from(payload.data, 'base64')).toEqual(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  });

  it('persists the boot theme snapshot for the frame parent handoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cursem-boot-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const { base } = await fixture({ bootThemePath: join(root, 'boot-theme.json') });

    await expect(fetch(`${base}/api/platform/theme`).then((response) => response.json())).resolves.toBeNull();

    const write = await fetch(`${base}/api/platform/theme`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ themeId: 'tokyo-night', backgroundColor: '#16161e', appearance: 'dark' }),
    });
    expect(write.status).toBe(200);
    await expect(fetch(`${base}/api/platform/theme`).then((response) => response.json()))
      .resolves.toEqual({ themeId: 'tokyo-night', backgroundColor: '#16161e', appearance: 'dark' });
    expect(JSON.parse(await readFile(join(root, 'boot-theme.json'), 'utf8')).themeId).toBe('tokyo-night');

    const invalid = await fetch(`${base}/api/platform/theme`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ themeId: 'tokyo-night', backgroundColor: '#16161e', appearance: 'sepia' }),
    });
    expect(invalid.status).toBe(400);
  });

  it('exposes profile migration as a read-only preview operation', async () => {
    const migrationService = { preview: async (source) => ({ source, found: true, preferences: { fontSize: 17 }, importedKeys: ['fontSize'] }) };
    const { base } = await fixture({ migrationService });
    const response = await fetch(`${base}/api/migration/preview?source=cursor`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ source: 'cursor', preferences: { fontSize: 17 } });
  });
});
