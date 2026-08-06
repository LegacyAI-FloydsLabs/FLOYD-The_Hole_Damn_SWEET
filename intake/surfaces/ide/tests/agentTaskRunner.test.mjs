// @vitest-environment node
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentTaskRunner } from '../server/agent-task-runner.mjs';

const cleanups = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function fixture() {
  // Canonicalize like the runner does (macOS /var → /private/var).
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cursem-task-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return { root, runner: createAgentTaskRunner({ workspaceRoot: root }) };
}

describe('approved Agent task runner', () => {
  it('runs a bounded argument vector without a shell and preserves exit evidence', async () => {
    const { root, runner } = await fixture();
    const success = await runner.run({ executable: 'node', args: ['-e', 'process.stdout.write("verified")'], cwd: root });
    expect(success).toMatchObject({ executable: 'node', args: ['-e', 'process.stdout.write("verified")'], cwd: root, stdout: 'verified', exitCode: 0 });
    const failure = await runner.run({ executable: 'node', args: ['-e', 'process.stderr.write("bad");process.exit(7)'], cwd: root });
    expect(failure).toMatchObject({ stderr: 'bad', exitCode: 7 });
  });

  it('rejects shells, mutating Git, multiline arguments, and cwd escapes', async () => {
    const { root, runner } = await fixture();
    await expect(runner.run({ executable: 'zsh', args: ['-lc', 'echo unsafe'], cwd: root })).rejects.toMatchObject({ status: 403 });
    await expect(runner.run({ executable: 'git', args: ['reset', '--hard'], cwd: root })).rejects.toMatchObject({ status: 403 });
    await expect(runner.run({ executable: 'node', args: ['one\ntwo'], cwd: root })).rejects.toMatchObject({ status: 400 });
    await expect(runner.run({ executable: 'node', args: [], cwd: tmpdir() })).rejects.toMatchObject({ status: 403 });
  });

  it('terminates the child when its abort signal fires', async () => {
    const { root, runner } = await fixture();
    const controller = new AbortController();
    const pending = runner.run({ executable: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], cwd: root }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
