import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyPayload } from '../scripts/verify-package-payload.mjs';

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
