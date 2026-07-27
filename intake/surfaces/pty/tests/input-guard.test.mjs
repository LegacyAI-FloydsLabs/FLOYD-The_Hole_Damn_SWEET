#!/usr/bin/env node
/**
 * Unit tests for the input/dictation guard.
 *
 * Drives the red-green-refactor fix for:
 *  - typing lag / lost characters on quick keystrokes
 *  - iOS dictate-to-text double/triple-echo from duplicated or overlapping partials
 */

import { InputGuard } from '../public/input-guard.mjs';
import assert from 'assert';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function test(name, fn) {
  try {
    await fn();
    console.log('  ✓ ' + name);
  } catch (err) {
    console.error('\n✗ ' + name);
    throw err;
  }
}

function makeGuard(opts = {}) {
  const sent = [];
  const g = new InputGuard({
    send: (d) => sent.push(d),
    identicalDedupeMs: opts.identicalDedupeMs ?? 500,
  });
  return { g, sent };
}

async function run() {
  console.log('InputGuard unit tests (TDD)');

  await test('single char is sent immediately', () => {
    const { g, sent } = makeGuard();
    g.onData('a');
    assert.deepStrictEqual(sent, ['a']);
    g.dispose();
  });

  await test('two chars quickly are both sent, no overwrite', async () => {
    const { g, sent } = makeGuard();
    g.onData('a');
    await sleep(5);
    g.onData('b');
    assert.deepStrictEqual(sent, ['a', 'b'], 'lost/overwritten characters');
    g.dispose();
  });

  await test('typing whole word sends each character', async () => {
    const { g, sent } = makeGuard();
    for (const ch of 'echo') {
      g.onData(ch);
      await sleep(5);
    }
    assert.deepStrictEqual(sent, ['e', 'c', 'h', 'o']);
    g.dispose();
  });

  await test('identical multi-char events within dedupe window are dropped', async () => {
    const { g, sent } = makeGuard({ identicalDedupeMs: 200 });
    g.onData('hello world');
    await sleep(20);
    g.onData('hello world');
    await sleep(20);
    g.onData('hello world');
    await sleep(20);
    assert.deepStrictEqual(sent, ['hello world'], 'repeated STT phrase was not deduped');
    g.dispose();
  });

  await test('repeated single characters are never deduped (real typing)', async () => {
    const { g, sent } = makeGuard({ identicalDedupeMs: 500 });
    g.onData('a');
    await sleep(20);
    g.onData('a');
    await sleep(20);
    g.onData('a');
    assert.deepStrictEqual(sent, ['a', 'a', 'a'], 'legitimate repeated keystrokes were dropped');
    g.dispose();
  });

  await test('dictation cumulative partials produce final phrase once', async () => {
    const { g, sent } = makeGuard();
    g.onData('this');
    await sleep(10);
    g.onData('this is');
    await sleep(10);
    g.onData('this is a');
    await sleep(10);
    g.onData('this is a test');
    await sleep(10);
    assert.strictEqual(sent.join(''), 'this is a test', 'screen text duplicated/truncated');
    assert.ok(!sent.some((s) => s.includes('this this')), 'prefix duplicated');
    g.dispose();
  });

  await test('dictation suffix overlap produces final phrase once', async () => {
    const { g, sent } = makeGuard();
    g.onData('hello world');
    await sleep(40);
    g.onData('world peace');
    await sleep(10);
    assert.strictEqual(sent.join(''), 'hello world peace', 'suffix overlap not suppressed');
    g.dispose();
  });

  await test('repeating the same final phrase does not re-send it', async () => {
    const { g, sent } = makeGuard();
    g.onData('done');
    await sleep(50);
    g.onData('done');
    await sleep(50);
    g.onData('done');
    await sleep(50);
    assert.deepStrictEqual(sent, ['done']);
    g.dispose();
  });

  await test('control character resets overlap baseline', () => {
    const { g, sent } = makeGuard();
    g.onData('hello');
    g.onData('\n');
    g.onData('world');
    assert.deepStrictEqual(sent, ['hello', '\n', 'world']);
    g.dispose();
  });

  await test('pasting printable text sends it once', () => {
    const { g, sent } = makeGuard();
    g.onData('paste this sentence');
    assert.deepStrictEqual(sent, ['paste this sentence']);
    g.dispose();
  });

  // ── Regression: dictation doubling ──────────────────────────────────────
  // v1 bug: a single-char event (space, first char, IME marker) between the
  // last multi-char partial and the compositionend finalization called
  // _resetBaseline(), zeroing _lastSent. The full phrase then arrived with no
  // baseline to diff against → sent in full → DOUBLED. v2 appends single chars
  // to a rolling buffer instead, so the finalization is recognized as
  // already-sent and suppressed.

  await test('dictation: single char between partial and final does NOT double', async () => {
    const { g, sent } = makeGuard();
    // Partials stream in cumulatively.
    g.onData('hello');
    await sleep(10);
    g.onData('hello world');
    await sleep(10);
    // iOS fires a single char (space / first char of finalization) — this was
    // the bug trigger in v1.
    g.onData(' ');
    await sleep(10);
    // compositionend re-fires the full phrase.
    g.onData('hello world');
    const joined = sent.join('');
    assert.strictEqual(joined, 'hello world ', 'dictation finalization was doubled');
    assert.ok(!joined.includes('hello worldhello'), 'full phrase re-sent after single char');
    g.dispose();
  });

  await test('dictation: compositionend full phrase suppressed after word partials', async () => {
    const { g, sent } = makeGuard();
    // Word-by-word partials (non-cumulative, space-delimited).
    g.onData('hello ');
    await sleep(10);
    g.onData('hello world');
    await sleep(10);
    // Finalization re-fires the complete phrase.
    g.onData('hello world');
    const joined = sent.join('');
    assert.strictEqual(joined, 'hello world', 'finalization doubled after cumulative partials');
    g.dispose();
  });

  await test('single char between dictation partials does not break suffix logic', async () => {
    const { g, sent } = makeGuard();
    g.onData('foo');
    await sleep(10);
    g.onData('b');            // single char — appends to buffer, no reset
    await sleep(10);
    g.onData('ar');           // next partial
    await sleep(10);
    g.onData('foobar');       // finalization
    const joined = sent.join('');
    assert.strictEqual(joined, 'foobar', 'interleaved single char broke delta');
    g.dispose();
  });

  console.log('\nAll input-guard tests passed!');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
