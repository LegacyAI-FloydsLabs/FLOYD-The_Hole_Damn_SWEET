---
name: diff-forensics
description: Extract maximum signal from a diff before reading full files — hunk-level risk triage, hidden-coupling detection, and change-intent mismatch checks. Use at the start of every code review.
---

# Diff Forensics

Work the diff before the files. Order of extraction:

1. `git diff --stat` — spot the outlier: the file with 10x the churn of the
   others usually holds the risk; generated/lock files get verified as
   generated and then excluded from deep review.
2. Hunk triage per file, tagging each hunk: LOGIC (branches, arithmetic,
   comparisons), STATE (init, mutation order, lifecycle), CONTRACT (public
   signatures, schemas, wire formats), GUARD (validation, auth, error paths),
   COSMETIC. Review order: CONTRACT → GUARD → STATE → LOGIC → COSMETIC.
3. Deleted-line audit — read removed lines as carefully as added ones. Ask of
   every deleted guard/branch: what now handles this case? "Nothing" is a
   finding.
4. Hidden coupling — for each changed symbol run a repo-wide usage search;
   callers NOT in the diff are the compatibility risk surface. List them.
5. Intent match — restate what the diff claims to do (title/commits), then
   list every hunk that is not required for that intent. Unrelated hunks are
   scope creep and get their own finding.
6. Boundary sweep per LOGIC hunk: off-by-one, empty input, null, max-size,
   unicode, concurrent access — check the specific ones the types allow.

Output of this skill is the triage table (file → hunks → tags → risk rank)
that drives which files get full-context reads.
