import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { prepareTerminalRuntime } from '../scripts/prepare-terminal-runtime.mjs';

test('all three terminal dependencies become executable before their real shell check', async t => {
  const root = await mkdtemp(join(tmpdir(), 'floyd-pty-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const suffix = 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper';
  for (const surface of ['ide', 'launcher', 'pty']) {
    const helper = join(root, 'intake/surfaces', surface, suffix);
    await mkdir(dirname(helper), { recursive: true });
    await writeFile(helper, 'fixture', { mode: 0o644 });
  }
  const checked = [];
  await prepareTerminalRuntime(root, { platform: 'darwin', arch: 'arm64', smoke: async project => {
    assert.equal((await stat(join(project, suffix))).mode & 0o777, 0o755);
    checked.push(project);
  } });
  assert.equal(checked.length, 3);
});

test('missing terminal helper fails the build instead of silently skipping it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'floyd-pty-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(prepareTerminalRuntime(root, { platform: 'darwin', arch: 'arm64', smoke: async () => {} }), /ENOENT/);
});
