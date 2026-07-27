---
name: dependency-sequencing
description: Order plan steps by true dependency, mark what can run in parallel, and place verification/rollback gates so execution never blocks or backtracks. Use when sequencing any multi-step plan.
---

# Dependency Sequencing

A plan's order is a claim about dependencies. Make it explicit and correct:

1. Dependency graph — for each step list what it REQUIRES (a file that must
   exist, a service that must be up, a migration that must have run) and what
   it PRODUCES. A step may start only when all its requirements are produced.
2. Topological order — sequence steps so no step precedes its requirements.
   Cycles are a design flaw: break them by splitting a step, not by hoping.
3. Parallel sets — steps with no dependency between them are marked
   parallelizable (a "wave"). Say so explicitly; a serial plan that could be
   parallel wastes execution time, and a parallel plan with a hidden
   dependency corrupts state.
4. Gates — place a verification checkpoint after any step whose failure would
   invalidate later work (schema change, shared-module edit, deploy). Later
   steps do not start until the gate passes.
5. Rollback ordering — the undo sequence is the forward sequence reversed, and
   every irreversible step (data migration, external publish, deletion) is
   flagged as a one-way door that needs explicit confirmation before it runs.
6. Critical path — identify the longest dependency chain; that is the
   plan's real duration and where slippage hurts. Call it out.

Output augments each PLAN-### step with: requires, produces, wave/serial,
gate?, rollback-position.
