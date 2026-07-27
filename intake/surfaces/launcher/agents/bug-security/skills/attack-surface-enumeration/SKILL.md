---
name: attack-surface-enumeration
description: Systematic enumeration of a target's failure and attack surfaces so hunting is exhaustive by construction, not by luck. Use at the start of a bug/security pass.
---

# Attack Surface Enumeration

Coverage comes from a checklist, not intuition. Walk every axis and record
the concrete surfaces the target actually has:

- INPUT edges: CLI args, HTTP params/bodies/headers, file parsers, env vars,
  stdin, deserializers, message queues. For each: is input validated before
  use, and what type-confusion or injection does the sink allow?
- AUTH boundaries: every transition between trust levels — unauth→auth,
  user→admin, tenant→tenant. Check each for missing/again-checkable enforcement.
- STATE machines: multi-step flows, caches, sessions, retries. Look for
  order-dependence, TOCTOU, stale reads, replay.
- CONCURRENCY: shared mutable state, unsynchronized access, async ordering,
  resource cleanup on error paths.
- I/O and RESOURCES: path handling (traversal), external calls (SSRF),
  unbounded allocation/loops (DoS), temp-file races.
- SECRETS: where credentials are read, logged, passed to children,
  serialized, or error-messaged.
- DEPENDENCIES: recently changed manifests/lockfiles; call sites of known-risky
  functions.

Emit SUR-### rows: surface, location, the failure classes it could exhibit.
Every confirmed finding must trace back to an enumerated surface; a finding
with no surface means the enumeration was incomplete — extend it.
