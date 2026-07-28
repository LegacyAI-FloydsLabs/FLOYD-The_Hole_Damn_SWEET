# FLOYD-The_Hole_Damn_SWEET

![FLOYD — The Hole Damn SWEET](assets/hero.jpg)

FLOYD ecosystem monorepo: Floyd Core daemon, FLOYD Frame shell, managed app
surfaces, SDK, and the OpenCode engine integration.

- Active shell: `apps/frame` (http://floyd.localhost:13030). Legacy cockpit is
  quarantined under `quarantine/cockpit` (tests/debug only).
- Contract and fixed decisions: `FLOYD.md`.

## Install

Requires macOS, Node >= 26 (Homebrew node preferred), npm, and `qrencode`
(`brew install qrencode`) for local QR handoff rendering.

```sh
git clone https://github.com/LegacyAI-FloydsLabs/FLOYD-The_Hole_Damn_SWEET.git
cd FLOYD-The_Hole_Damn_SWEET
npm install
npm run typecheck        # builds TS project references
npm test                 # full suite
node apps/frame/server/frame-server.mjs   # frame shell on :13030
```

Optional persistent services (the only LaunchAgents this repo installs):
`./scripts/new-world-bootstrap.sh` (idempotent PASS/FAIL adoption of a fresh
machine) or `npm run core:install` for Floyd Core alone. Provider keys stay in
the Vault's macOS Keychain storage. Managed applications receive only persistent
`fv_...` capabilities and loopback Vault addresses; enter or rotate provider
keys only in the Frame Keys panel.

## Status

- Testing: use `npm test` plus each managed surface's local suite; final
  receipts are produced from the current checkout rather than a stale count.
- Dogfood: frame daily-driver verified on desktop and mobile viewports;
  rendered-browser visual proof and reboot survival remain manual checks.
- Credential authority: the Vault is the single in-FLOYD provider credential
  proxy, including HTTP and Google Live WebSocket transports.

## Policy

Only application runtime files are tracked. Planning docs, session logs,
reports, and dogfood output stay untracked. Testing and readiness are
summarized here, not in tracked side documents.
