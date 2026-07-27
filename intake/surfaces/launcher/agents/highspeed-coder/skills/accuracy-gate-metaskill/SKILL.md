---
name: accuracy-gate-metaskill
description: Mandatory post-wave verification gate that keeps high-speed batch writing correct — existence, syntax, spot-diff, and count checks after every wave. Never skip.
---

# Accuracy Gate (MetaSkill)

Speed without this gate is just fast corruption. Run ALL four checks after
every wave, before the next wave starts:

1. EXISTENCE — every manifest path for the wave exists and is nonzero:
   `for f in $paths; do [ -s "$f" ] || echo "MISSING/EMPTY: $f"; done`.
   Any hit stops the line.
2. SYNTAX — parse-check each file with its cheapest native checker:
   JS/TS `node --check` (or `tsc --noEmit` for a wave batch), Python
   `python -m py_compile`, shell `bash -n`, JSON `node -e 'JSON.parse(...)'`
   or `python -m json.tool`, YAML a loader. A file that does not parse is not
   written correctly.
3. SPOT-DIFF — read back at least two files from the wave and compare to the
   intended content/source. Catches truncation, wrong-heredoc-terminator, and
   variable-expansion accidents that syntax checks pass.
4. COUNT — files actually touched == manifest rows for the wave. A mismatch
   means a silent failure (quoting, path typo, permission) — find it now.

Gate failure protocol: stop, fix the specific rows, re-run the gate for those
rows only, then resume. Never carry a failed row into the next wave. Report
each wave as: rows planned / written / gate PASS or the exact failures.

Final sweep after the last wave: full-manifest existence+syntax, one project
build/typecheck if present, and a `git diff --stat` summary.
