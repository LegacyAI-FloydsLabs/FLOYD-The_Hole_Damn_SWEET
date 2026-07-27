---
name: rollback-first
description: Establish and verify a working rollback path BEFORE cutover, so every deploy is reversible under failure. Use before touching any live service.
---

# Rollback First

The rule: you may not break the running thing until you have proven you can
put it back.

Before cutover, establish:
1. Restore point — the exact artifact, image tag, git revision, or config
   snapshot that represents the current-good state. Named, located, and
   confirmed present on disk/registry — not "the last build, probably".
2. Restore procedure — the literal commands to revert: symlink repoint,
   service restart against the old artifact, container retag, config restore.
   Written down before cutover, not improvised during an incident.
3. Restore verification — confirm the restore artifact actually loads/runs in
   isolation if the environment allows (e.g. the old binary executes, the old
   image pulls). An untested rollback is a hope, not a plan.
4. Trigger criteria — the specific smoke/continuity failures that mean "roll
   back now" rather than "debug forward on the live service".

During cutover keep the restore point one command away. After a failed smoke
or continuity check, execute the rehearsed rollback immediately, then diagnose
off the live path. Data-layer changes (migrations) need a separate down-path
proven before the up-path runs; forward-only migrations are flagged to the
user as an irreversible rung requiring explicit confirmation.
