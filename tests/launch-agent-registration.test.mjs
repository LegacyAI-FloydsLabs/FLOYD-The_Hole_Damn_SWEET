import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { registerUserAgent } from '../scripts/register-user-launch-agent.mjs';

async function fixture(t, old = 'old', next = 'new') {
  const dir = await mkdtemp(join(tmpdir(), 'floyd-agent-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'com.floyd.frame.plist');
  const candidate = join(dir, 'candidate.plist');
  await writeFile(target, old); await writeFile(candidate, next);
  return { label: 'com.floyd.frame', target, candidate, uid: '501' };
}
test('replacement tolerates launchd still releasing the old service', async t => {
  const input = await fixture(t); let calls = 0;
  const result = await registerUserAgent(input, { pause: async () => {}, run(command, args) {
    if (args[0] === 'bootstrap' && ++calls < 3) throw Object.assign(new Error('releasing old job'), {status:5});
  } });
  assert.equal(calls, 3); assert.equal(result.changed, true);
  assert.equal(await readFile(input.target, 'utf8'), 'new');
  assert.equal(await readFile(`${input.target}.previous`, 'utf8'), 'old');
});
test('a failed replacement restores and starts the previous definition', async t => {
  const input = await fixture(t); let calls = 0;
  await assert.rejects(registerUserAgent(input, { pause: async () => {}, run(command, args) {
    if (args[0] === 'bootstrap' && ++calls <= 20) throw Object.assign(new Error('cannot load'), {status:5});
  } }), /previous service settings restored/);
  assert.equal(calls, 21); assert.equal(await readFile(input.target, 'utf8'), 'old');
});
test('opening an already registered app does not restart its services', async t => {
  const input = await fixture(t, 'same', 'same'); const operations = [];
  const result = await registerUserAgent(input, { run(command, args) { operations.push(args[0]); } });
  assert.equal(result.changed, false); assert.deepEqual(operations, ['-lint', 'print']);
});
