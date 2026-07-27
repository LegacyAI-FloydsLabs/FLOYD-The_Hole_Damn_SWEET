---
name: fact-anchoring
description: Ground every factual claim in a verifiable source before publishing, and carry the sources as an appendix. Use whenever content makes technical or numeric claims.
---

# Fact Anchoring

Content that states facts must be traceable to them. Method:

1. Extract claims — list every checkable assertion the draft makes: version
   numbers, command syntax, file paths, capability statements, metrics, names.
2. Source each — attach a source to every claim: a repo file+line, a command
   whose output you ran, or a fetched URL. A claim with no attachable source
   is verified now or cut. There is no third option.
3. Test runnable claims — commands and code blocks in the piece get executed
   in a scratch area when the environment allows; a command that does not run
   as written is a bug in the content.
4. Version-pin — when a claim depends on a version ("requires Node 20"),
   verify against the actual manifest/lockfile, not memory.
5. Appendix — technical pieces ship with a fact base: claim → source. It is
   the reviewer's audit trail and your defense against drift.

Red lines: never invent a feature, flag, metric, or quote; never state a
capability the code does not have; never carry a claim forward from a prior
draft without re-checking it against current sources.
