# Quarantine

Components kept for provenance/tests but NOT part of the active surface set.
Do not extend these. The active user-facing shell is `apps/frame/` (FLOYD Frame,
http://floyd.localhost:13030/).

- `cockpit/` — the original Floyd Core web cockpit (single-page natural-language
  client served by the Core gateway). Superseded as the daily-driver shell by
  `apps/frame/`. Core still serves it from this quarantined path for its
  contract tests and as a fallback debug surface; quarantined 2026-07-21 to
  avoid confusion with the frame.
