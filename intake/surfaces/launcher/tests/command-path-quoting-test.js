#!/usr/bin/env node
'use strict';

/**
 * Regression Test — Command Path Quoting (CR-013)
 *
 * The launcher writes the harness launch command as a string into a PTY
 * login shell. Args were already single-quoted (CR-004), but the resolved
 * binary path itself was spliced raw — so when the launcher is installed
 * under a path containing spaces (the shipped app lives at
 * "/Applications/FLOYD Desktop Suite.app/..."), zsh word-split the path and
 * tried to execute the first word:
 *
 *   zsh: no such file or directory: /Applications/FLOYD
 *
 * This test is PTY-free (node-pty cannot spawn from a plain shell in every
 * environment). It asserts the string construction directly AND proves the
 * constructed line end-to-end through a real /bin/zsh:
 *   1. buildLaunchCommand single-quotes a space-containing path
 *   2. embedded single quotes in a path survive the '"'"' idiom
 *   3. compound command strings ("npx -y @scope/pkg") pass through unquoted
 *   4. args remain single-quoted (CR-004 regression guard)
 *   5. a stub script living at a space-containing path actually executes via
 *      `zsh -c <constructed command>` and receives its args intact
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { buildLaunchCommand } = require('../src/shell-quote');

const SPACE_PATH = '/Applications/FLOYD Desktop Suite.app/Contents/Resources/workstation/intake/surfaces/launcher/agents/bin/highspeed-coder';

// 1. Space-containing single path is single-quoted.
assert.equal(
  buildLaunchCommand(SPACE_PATH, []),
  `'${SPACE_PATH}'`,
  'space-containing path must be wrapped in single quotes'
);

// 1b. Quoted path + args: args appended after the closing quote, each quoted.
assert.equal(
  buildLaunchCommand(SPACE_PATH, ['--fast', 'two words']),
  `'${SPACE_PATH}' '--fast' 'two words'`,
  'args must be appended individually quoted after the quoted path'
);

// 2. Embedded single quote in a path uses the '"'"' idiom.
assert.equal(
  buildLaunchCommand(`/it's here/bin/agent`, []),
  `'/it'"'"'s here/bin/agent'`,
  `embedded single quote must use the '"'"' idiom`
);

// 3. Compound command strings pass through untouched (their own spacing is
// meaningful); args are still quoted after them.
assert.equal(
  buildLaunchCommand('npx -y @scope/pkg', ['--flag']),
  `npx -y @scope/pkg '--flag'`,
  'compound command string must pass through with its spacing intact'
);

// 4. CR-004 regression guard: shell metacharacters in args stay inert.
assert.equal(
  buildLaunchCommand('/bin/agent', ['; echo PWNED #', '$(whoami)']),
  `'/bin/agent' '; echo PWNED #' '$(whoami)'`,
  'args with shell metacharacters must remain single-quoted'
);

// 5. End-to-end through a real zsh: a stub at a space-containing path must
// execute and receive its args as single words.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floyd launcher quoting test-'));
try {
  const stubDir = path.join(tmpRoot, 'agents', 'bin');
  fs.mkdirSync(stubDir, { recursive: true });
  const stub = path.join(stubDir, 'highspeed-coder');
  fs.writeFileSync(stub, '#!/bin/zsh\nprint -r -- "STUB_RAN argc=$#"\nprint -r -- "arg1=$1"\n');
  fs.chmodSync(stub, 0o755);

  const command = buildLaunchCommand(stub, ['two words']);
  const run = spawnSync('/bin/zsh', ['-c', command], { encoding: 'utf8' });
  assert.equal(run.status, 0, `zsh exited ${run.status}: ${run.stderr}`);
  assert.ok(run.stdout.includes('STUB_RAN argc=1'), `stub did not run.\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
  assert.ok(run.stdout.includes('arg1=two words'), `space-containing arg was word-split.\nstdout: ${run.stdout}`);

  // Counter-proof: the SAME stub spliced raw (the old behavior) fails with
  // the exact user-reported signature — confirms this test exercises the bug.
  const rawRun = spawnSync('/bin/zsh', ['-c', `${stub} 'two words'`], { encoding: 'utf8' });
  const firstWord = stub.split(' ')[0];
  assert.notEqual(rawRun.status, 0, 'raw splice unexpectedly succeeded — test is not exercising the bug');
  assert.ok(
    rawRun.stderr.includes(`no such file or directory: ${firstWord}`),
    `expected the word-split signature "${firstWord}", got: ${rawRun.stderr}`
  );
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log('  quoted space path:        OK');
console.log('  embedded quote idiom:     OK');
console.log('  compound passthrough:     OK');
console.log('  arg quoting (CR-004):     OK');
console.log('  zsh end-to-end exec:      OK');
console.log('  raw-splice counter-proof: OK');
console.log('');
console.log('✅ PASS — harness binary path is shell-quoted (CR-013)');
