---
name: reproduce-or-refute
description: Discipline that converts a suspected bug/vuln into either a replayable proof-of-concept or a documented refutation. Use before reporting any defect.
---

# Reproduce or Refute

No finding leaves this agent as a hypothesis. Each suspected defect runs the
loop:

1. State the hypothesis concretely: component + input/condition + predicted
   wrong behavior. Vague ("might be unsafe") is not yet a hypothesis; sharpen
   it until it predicts an observable.
2. Build the cheapest test that would show it: a minimal input, a unit test, a
   curl, a scratch script under the scratchpad. Prefer a runnable artifact
   over a mental argument.
3. Run it.
   - Predicted wrong behavior observed → CONFIRMED. Save exact replay steps
     (commands + inputs + observed output) so another agent reproduces it
     cold.
   - Correct behavior observed → follow the code to find the guard that saved
     it; record it as KILLED with that guard's location. Killed hypotheses
     ship in the report — they map the safe surface.
   - Cannot run (missing env/creds/data) → UNTESTABLE; trace the path
     statically as far as it goes and record exactly what is needed to finish.
4. For confirmed security issues, add exploitability: who triggers it, from
   where, with what preconditions, and the blast radius.

Never escalate severity to compensate for weak reproduction. A vivid story is
not a repro.
