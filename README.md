# FLOYD-THE_WHOLE_DAMN_SUITE

FLOYD ecosystem monorepo: Floyd Core daemon, FLOYD Frame shell, managed
app surfaces, SDK, and the OpenCode engine integration.

- Active shell: `apps/frame` (http://floyd.localhost:13030). The legacy
  cockpit is quarantined under `quarantine/cockpit` (tests/debug only).
- Contract and fixed decisions: `FLOYD.md`.

## Readiness

As of the last verified run (2026-07-15, pre-FloydShell commits):

- Typecheck: passing (tsc project references, exit 0).
- Tests: 154/154 passing (`npm test`: sdk, opencode engine, core daemon, cli).
- Core release flow: commit-addressed releases with health gate and
  rollback, verified live (`CORE_RELEASE PASS`).
- Surfaces: `npm run verify:surfaces` passing.
- Known gaps: credential authority rework in progress (the Vault becomes
  the single in-FLOYD credential proxy for LLM APIs; see branch
  `salvage/v1.8.0-credential-proxy`). Rendered-browser visual proof and
  reboot-survival checks remain manual.

## Policy

Only application runtime files are tracked. Planning docs, session logs,
reports, and dogfood output stay untracked. Testing and readiness are
summarized here, not in tracked side documents.
