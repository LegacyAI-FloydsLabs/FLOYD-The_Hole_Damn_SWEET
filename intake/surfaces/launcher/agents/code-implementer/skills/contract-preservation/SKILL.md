---
name: contract-preservation
description: Prove an edit did not silently break callers, API shape, or error semantics before declaring it done. Use after any change to a shared symbol, signature, or public behavior.
---

# Contract Preservation

Changing a function is easy; not breaking its 20 callers is the job. After any
edit to a symbol that others depend on, run the preservation check:

1. Blast radius — repo-wide search for every caller/importer of the changed
   symbol. Callers NOT in your diff are the ones at risk; enumerate them.
2. Signature invariance — parameters (count, order, types, optionality),
   return shape, and thrown/rejected error types must be unchanged unless the
   task explicitly changes them. If they change, every caller in the blast
   radius is now an edit site or a documented break.
3. Error-semantics invariance — a path that used to throw must still throw
   (same type), a nullable return must stay nullable, a validation that
   rejected input must still reject it. Silent widening/narrowing of accepted
   input is a contract break even when types compile.
4. Wire/format invariance — for anything serialized (HTTP responses, DB rows,
   events, files), field names, presence, and encoding are the contract.
   Diff the produced shape, not just the code.
5. Test the boundary — run the tests that exercise the callers, not only the
   changed unit. Green unit + red integration means the contract moved.

Any intentional contract change is called out explicitly in the report with
its migration impact; any unintentional one is a defect to fix now, not later.
