import { describe, expect, it } from 'vitest';
import { computeLineDiff, parseUnifiedDiff } from '../src/components/chat/DiffView';
import { deriveDiffs } from '../src/components/chat/deriveDiff';

describe('client-side LCS line diff', () => {
  it('marks additions, deletions, and context with dual line numbers', () => {
    const rows = computeLineDiff('one\ntwo\nthree', 'one\nTWO\nthree\nfour');
    expect(rows).toEqual([
      { type: 'context', before: 1, after: 1, text: 'one' },
      { type: 'del', before: 2, text: 'two' },
      { type: 'add', after: 2, text: 'TWO' },
      { type: 'context', before: 3, after: 3, text: 'three' },
      { type: 'add', after: 4, text: 'four' },
    ]);
  });

  it('handles empty sides (create and delete)', () => {
    expect(computeLineDiff('', 'a\nb')).toEqual([
      { type: 'add', after: 1, text: 'a' },
      { type: 'add', after: 2, text: 'b' },
    ]);
    expect(computeLineDiff('a\nb', '')).toEqual([
      { type: 'del', before: 1, text: 'a' },
      { type: 'del', before: 2, text: 'b' },
    ]);
    expect(computeLineDiff('', '')).toEqual([]);
  });
});

describe('unified diff parsing', () => {
  it('tracks line numbers across hunks', () => {
    const rows = parseUnifiedDiff('@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three');
    expect(rows[0]).toMatchObject({ type: 'context', text: '@@ -1,3 +1,3 @@' });
    expect(rows[1]).toMatchObject({ type: 'context', before: 1, after: 1, text: 'one' });
    expect(rows[2]).toMatchObject({ type: 'del', before: 2, text: 'two' });
    expect(rows[3]).toMatchObject({ type: 'add', after: 2, text: 'TWO' });
    expect(rows[4]).toMatchObject({ type: 'context', before: 3, after: 3, text: 'three' });
  });
});

describe('deriveDiffs from <cursem-patch> changes', () => {
  it('maps create, modify, and delete to before/after pairs', () => {
    const diffs = deriveDiffs(
      [
        { path: 'src/new.ts', content: 'new body' },
        { path: 'src/edit.ts', content: 'after' },
        { path: 'src/old.ts', content: null },
      ],
      { 'src/edit.ts': 'before', 'src/old.ts': 'legacy' },
    );
    expect(diffs).toEqual([
      { path: 'src/new.ts', before: '', after: 'new body', operation: 'create' },
      { path: 'src/edit.ts', before: 'before', after: 'after', operation: 'modify' },
      { path: 'src/old.ts', before: 'legacy', after: '', operation: 'delete' },
    ]);
  });
});
