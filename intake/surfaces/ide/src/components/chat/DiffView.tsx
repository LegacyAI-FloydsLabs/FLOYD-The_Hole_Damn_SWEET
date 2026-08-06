// ─── Diff view (Phase 4 S4) ─────────────────────────────────────────────
//
// Client-side line diff with no dependency: an O(m·n) LCS dynamic program
// over line arrays (ported from Cate's ChatDiffView approach), with a hard
// cell-count bailout that degrades to a whole-file replace rendering instead
// of ever freezing the UI on huge files. Also renders unified-diff text
// (git_diff tool results) and exposes the row model for tests.

import { useMemo } from 'react';

export interface DiffLine {
  type: 'context' | 'add' | 'del';
  before?: number;
  after?: number;
  text: string;
}

const MAX_LCS_CELLS = 250_000;
const MAX_RENDER_LINES = 2_000;

function splitLines(text: string): string[] {
  return text.length ? text.split('\n') : [];
}

/**
 * Compute a line-level diff between two file bodies. Falls back to a
 * delete-all + add-all rendering when the DP table would exceed the cell
 * budget, matching Cate's 250k-cell bailout.
 */
export function computeLineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length * b.length > MAX_LCS_CELLS) {
    return [
      ...a.map((text, index) => ({ type: 'del' as const, before: index + 1, text })),
      ...b.map((text, index) => ({ type: 'add' as const, after: index + 1, text })),
    ];
  }
  // lengths[i][j] = LCS length of a[i:] and b[j:], filled bottom-up.
  const widths = b.length + 1;
  const lengths = new Uint32Array((a.length + 1) * widths);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i * widths + j] = a[i] === b[j]
        ? lengths[(i + 1) * widths + j + 1] + 1
        : Math.max(lengths[(i + 1) * widths + j], lengths[i * widths + j + 1]);
    }
  }
  const rows: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ type: 'context', before: i + 1, after: j + 1, text: a[i] });
      i += 1; j += 1;
    } else if (lengths[(i + 1) * widths + j] >= lengths[i * widths + j + 1]) {
      rows.push({ type: 'del', before: i + 1, text: a[i] });
      i += 1;
    } else {
      rows.push({ type: 'add', after: j + 1, text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) { rows.push({ type: 'del', before: i + 1, text: a[i] }); i += 1; }
  while (j < b.length) { rows.push({ type: 'add', after: j + 1, text: b[j] }); j += 1; }
  return rows;
}

/** Parse unified-diff text (git_diff output) into display rows. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const rows: DiffLine[] = [];
  let beforeLine = 0;
  let afterLine = 0;
  for (const raw of splitLines(diff)) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      beforeLine = Number(hunk[1]);
      afterLine = Number(hunk[2]);
      rows.push({ type: 'context', text: raw });
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff ') || raw.startsWith('index ')) {
      rows.push({ type: 'context', text: raw });
      continue;
    }
    if (raw.startsWith('+')) { rows.push({ type: 'add', after: afterLine, text: raw.slice(1) }); afterLine += 1; continue; }
    if (raw.startsWith('-')) { rows.push({ type: 'del', before: beforeLine, text: raw.slice(1) }); beforeLine += 1; continue; }
    rows.push({ type: 'context', before: beforeLine || undefined, after: afterLine || undefined, text: raw.startsWith(' ') ? raw.slice(1) : raw });
    if (beforeLine) beforeLine += 1;
    if (afterLine) afterLine += 1;
  }
  return rows;
}

function DiffRows({ rows }: { rows: DiffLine[] }) {
  const clipped = rows.length > MAX_RENDER_LINES ? rows.slice(0, MAX_RENDER_LINES) : rows;
  return (
    <div className="diff-view" role="table" aria-label="Line diff">
      {clipped.map((row, index) => (
        <div key={index} className={`diff-row ${row.type}`} role="row">
          <span className="diff-line-no">{row.before ?? ''}</span>
          <span className="diff-line-no">{row.after ?? ''}</span>
          <span className="diff-sign">{row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '}</span>
          <span className="diff-text">{row.text || ' '}</span>
        </div>
      ))}
      {rows.length > clipped.length && <div className="diff-truncated">… {rows.length - clipped.length} more lines</div>}
    </div>
  );
}

export function DiffView({ before, after, label }: { before: string; after: string; label?: string }) {
  const rows = useMemo(() => computeLineDiff(before, after), [before, after]);
  const added = rows.filter((row) => row.type === 'add').length;
  const removed = rows.filter((row) => row.type === 'del').length;
  return (
    <div className="diff-card">
      {label && <div className="diff-card-title"><span>{label}</span><span className="diff-stats">+{added} −{removed}</span></div>}
      <DiffRows rows={rows} />
    </div>
  );
}

export function UnifiedDiffView({ diff, label }: { diff: string; label?: string }) {
  const rows = useMemo(() => parseUnifiedDiff(diff), [diff]);
  return (
    <div className="diff-card">
      {label && <div className="diff-card-title"><span>{label}</span></div>}
      <DiffRows rows={rows} />
    </div>
  );
}
