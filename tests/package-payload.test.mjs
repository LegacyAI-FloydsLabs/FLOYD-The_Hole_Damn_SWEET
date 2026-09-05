import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyPayload } from '../scripts/verify-package-payload.mjs';

test('CLI creates and verifies the manifest through an aliased macOS staging path', async t => {
  const root = await mkdtemp(join(tmpdir(), 'floyd-payload-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'FLOYD.app');
  await mkdir(join(app, 'Contents/Resources'), { recursive: true });
  await writeFile(join(app, 'Contents/Resources/desktop.js'), 'production bundle');
  const inventory = join(root, 'inventory.json');
  await writeFile(inventory, JSON.stringify({ components: { desktop: ['Contents/Resources/desktop.js'] } }));
  const alias = join(root, 'verifier.mjs');
  await symlink(fileURLToPath(new URL('../scripts/verify-package-payload.mjs', import.meta.url)), alias);
  const output = execFileSync(process.execPath, [alias, 'create', app, inventory], { encoding: 'utf8' });
  assert.match(output, /FLOYD_PAYLOAD PASS/);
  assert.equal((await verifyPayload(app)).files, 1);
  await writeFile(join(app, 'Contents/Resources/desktop.js'), 'damaged bundle');
  assert.throws(() => execFileSync(process.execPath, [alias, 'verify', app], { stdio: 'pipe' }), /Command failed/);
});

test('payload verification detects missing, changed and extra installed files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'floyd-payload-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'Contents/Resources'), { recursive: true });
  const file = join(root, 'Contents/Resources/desktop.js');
  await writeFile(file, 'production bundle');
  const inventory = { components: { desktop: ['Contents/Resources/desktop.js'] } };
  await verifyPayload(root, { create: true, inventory });
  assert.equal((await verifyPayload(root)).files, 1);
  await writeFile(file, 'broken bundle');
  await assert.rejects(verifyPayload(root), /content mismatch/);
  await writeFile(file, 'production bundle');
  const extra = join(root, 'Contents/Resources/unexpected');
  await writeFile(extra, 'extra');
  await assert.rejects(verifyPayload(root), /Unexpected package content/);
  await rm(extra);
  await rm(file);
  await assert.rejects(verifyPayload(root), /Missing desktop/);
});

test('a dependency symlink must remain inside the installed application', async t => {
  const root = await mkdtemp(join(tmpdir(), 'floyd-payload-link-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'Contents/Resources'), { recursive: true });
  await symlink('/tmp', join(root, 'Contents/Resources/external'));
  await assert.rejects(verifyPayload(root, { create: true, inventory: { components: {} } }), /Link leaves application/);
});

test('packaged runtime must be accessible to an account other than its builder', async t => {
  const root = await mkdtemp(join(tmpdir(), 'floyd-payload-permissions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = join(root, 'Contents/Resources/workstation');
  await mkdir(runtime, { recursive: true });
  await chmod(runtime, 0o700);
  const file = join(runtime, 'server.mjs');
  await writeFile(file, 'runtime');
  const options = { create: true, inventory: { components: { runtime: ['Contents/Resources/workstation/server.mjs'] } } };
  await assert.rejects(verifyPayload(root, options), /directory is not readable/);
  await chmod(runtime, 0o755);
  await chmod(file, 0o600);
  await assert.rejects(verifyPayload(root, options), /file is not readable/);
  await chmod(file, 0o744);
  await assert.rejects(verifyPayload(root, options), /executable is not runnable/);
  await chmod(file, 0o755);
  assert.equal((await verifyPayload(root, options)).files, 1);
});
