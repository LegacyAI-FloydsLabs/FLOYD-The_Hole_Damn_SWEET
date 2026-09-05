import assert from 'node:assert/strict';
import test from 'node:test';
import { isExpectedNonGitFolder } from '../scripts/verification/expected-response.mjs';
test('only the exact non-Git-folder status response is classified as expected', () => {
  const url = 'http://127.0.0.1:13012/api/git/status?path=/Applications/FLOYD';
  const body = { error: { message: 'fatal: not a git repository (or any of the parent directories): .git' } };
  assert.equal(isExpectedNonGitFolder(url, 400, body), true);
  assert.equal(isExpectedNonGitFolder(url, 500, body), false);
  assert.equal(isExpectedNonGitFolder(url.replace('/status', '/diff'), 400, body), false);
  assert.equal(isExpectedNonGitFolder(url, 400, { error: { message: 'Permission denied' } }), false);
});
