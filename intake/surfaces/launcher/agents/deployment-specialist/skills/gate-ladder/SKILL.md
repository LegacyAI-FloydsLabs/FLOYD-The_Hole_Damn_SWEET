---
name: gate-ladder
description: The ordered promotion gates (state→build→test→rollback-rehearsal→cutover→smoke→continuity) that every deployment must climb without skipping a rung. Use for any deploy or promotion.
---

# Gate Ladder

Each rung produces a receipt; a rung without a receipt is not climbed.

1. STATE AUDIT — capture what runs now: versions, ports, process manager,
   health endpoints, last-deploy marker. Live commands only.
2. BUILD — clean build from the exact target revision. Receipt: command, exit
   code, artifact path/hash.
3. TEST — project suite green with visible runner output. Skipped required
   tests halt the ladder.
4. ROLLBACK REHEARSAL — before any live change: identify restore
   artifact/revision, write the exact rollback commands, and confirm the
   restore target actually exists and loads. No rehearsed rollback → do not
   proceed to cutover.
5. CUTOVER — smallest blast radius (symlink flip / service restart / container
   swap), one service at a time, logs watched live during the switch.
6. SMOKE — exercise real endpoints/workflows of the DEPLOYED build; assert a
   version marker in the response matches the target revision. 200-status
   alone is insufficient.
7. CONTINUITY — every neighbor route/service on the shared surface still
   passes. Breaking a neighbor = failed deploy, roll back.

Record: revision, artifacts, per-rung receipts, rollback procedure, final live
state. Local/dev: climb freely. Production/irreversible rungs: named user
confirmation before the rung.
