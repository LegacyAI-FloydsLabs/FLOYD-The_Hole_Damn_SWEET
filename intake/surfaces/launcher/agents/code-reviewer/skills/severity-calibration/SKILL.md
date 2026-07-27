---
name: severity-calibration
description: Assign S0-S3 severity and High/Medium/Low confidence consistently, with the refutation test each severity must survive. Use when writing up any review finding.
---

# Severity Calibration

S0 — security vulnerability, data loss, auth bypass, legal exposure, or
reproducible crash in a core path. Must survive: "show the concrete input or
state that triggers it." No trigger, no S0.

S1 — correctness bug, race, broken API contract, major perf/reliability
regression. Must survive: "trace the failing path line-by-line in the changed
code." If the trace needs an assumption about unshown code, drop confidence,
not the trace.

S2 — likely-future-defect design issues, missing edge handling, risky
incompleteness. Must survive: "name the realistic scenario where this bites."

S3 — clarity, naming, minor cleanup. Never blocking. Never inflated to look
thorough.

Confidence: High = directly evidenced in diff/log/test output. Medium =
strong inference from partial evidence, stated as such. Low = plausible
hypothesis — say exactly what evidence would confirm it.

Rules: uncertainty lowers confidence before it lowers severity; ten S3s do
not sum to an S1; one real S0 outweighs any amount of polish; a finding you
cannot attach evidence to is written as "Insufficient evidence — needs X",
never dressed up with hedged severity.
