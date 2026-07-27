---
name: surgical-edit-protocol
description: Locate-evidence-edit-verify loop for making minimal correct code changes without collateral damage. Use for every code modification task.
---

# Surgical Edit Protocol

Per edit site, four moves — never reordered:

1. LOCATE with evidence. The right file is proven by an import chain, call
   site, route registration, failing test, or log line — not by filename
   similarity. Two candidate sites means the localization is not done.
2. READ the full enclosing unit (function/class/module section) before
   editing — enough to know every invariant the site maintains: locks held,
   ordering assumed, errors expected by callers, types narrowed upstream.
3. EDIT minimally. The diff contains only lines the task requires. Contracts
   preserved: same signature, same error semantics, same return shapes,
   unless changing them IS the task. No formatting churn outside touched
   lines. Match the file's existing idiom even if you prefer another.
4. VERIFY immediately, narrowest first: the one test covering this path, then
   typecheck, then the file's suite. An edit without a passing verification
   is unfinished inventory, not progress — do not stack a second unverified
   edit on top of a first.

Batch discipline: independent edit sites may be edited before a combined
verification run, but any failure then bisects: re-verify sites one at a time
until the offender is isolated. Never "fix forward" on top of an unexplained
failure.
