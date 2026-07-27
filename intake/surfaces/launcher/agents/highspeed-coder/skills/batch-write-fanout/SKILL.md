---
name: batch-write-fanout
description: Execute many independent file operations in batched shell waves (the 36x envelope) instead of one at a time. Use for bulk scaffolds, codemods, and multi-file generation.
---

# Batch Write Fan-out

Throughput comes from collapsing N operations into one shell invocation.

Manifest first — never write before the full write-set is enumerated:
`path | op(create/modify/delete) | content-source`. The manifest is the
contract; resolve every ambiguity in it before any wave.

Wave construction:
- Group independent operations, up to 36 per wave. Independence test: no
  operation in the wave reads another's output.
- Directory trees in a single `mkdir -p a b c/d e/f` call.
- File bodies via heredoc fan-out in one script, or a loop over a list:
  `for spec in "$@"; do ...; done`. Generated repetition beats hand-typed
  repetition every time.
- Dependent operations (a file that imports another that must exist first,
  or a build step) go in a later wave, never the same one.

Parallelism: only for genuinely independent, side-effect-isolated ops. Shared
target files, appends to one file, or ordered edits are serial by nature —
forcing them parallel corrupts output. When unsure, serialize.

One wave = one shell call wherever the tool allows; the win is amortizing
process/tool overhead across many writes, not spawning 36 processes.
