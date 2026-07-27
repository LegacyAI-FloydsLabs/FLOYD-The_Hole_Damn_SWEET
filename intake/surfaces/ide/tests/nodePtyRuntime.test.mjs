import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureNodePtySpawnHelperExecutable } from '../server/node-pty-runtime.mjs';

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('node-pty runtime preparation', () => {
  it('restores the executable bit on the platform spawn helper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cursem-node-pty-'));
    temporaryRoots.push(root);
    const helper = join(root, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper');
    await mkdir(join(helper, '..'), { recursive: true });
    await writeFile(helper, '#!/bin/sh\n');
    await chmod(helper, 0o644);

    const result = ensureNodePtySpawnHelperExecutable(root, 'darwin', 'arm64');
    const mode = (await stat(helper)).mode & 0o777;

    expect(result).toEqual({ changed: true, path: helper });
    expect(mode).toBe(0o755);
  });

  it('does not alter Windows installations', () => {
    expect(ensureNodePtySpawnHelperExecutable('/unused', 'win32', 'x64')).toEqual({ changed: false, path: null });
  });
});
