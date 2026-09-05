# FLOYD-The_Hole_Damn_SWEET

![FLOYD — The Hole Damn SWEET](assets/hero.jpg)

FLOYD ecosystem monorepo: Floyd Core daemon, FLOYD Frame shell, managed app
surfaces, SDK, and the OpenCode engine integration. One unified workspace —
TUI, IDE, desktop/multimedia surface, and web terminals inside a single frame,
with one session that follows you across all of them and any LLM provider
routed through the Vault.

- Active shell: `apps/frame` (http://127.0.0.1:13030). Legacy cockpit is
  quarantined under `quarantine/cockpit` (tests/debug only).
- Contract and fixed decisions: `FLOYD.md` (read it first — it describes the
  current machine reality, including the runtime-root gotcha below).

## Rebuild and install on a clean Mac

The supported recovery path requires an Apple-silicon Mac running macOS 14 or
newer, Git LFS, Python 3, Node 26.5.0, and Google Chrome. Chrome is the runtime
host for FLOYD's internal browser and its two permanent extensions. The release
script performs frozen installs from every committed lockfile, rebuilds the
Desktop and IDE bundles, downloads and verifies the pinned OpenCode and Node
binaries, and packages only that fresh release tree.

```sh
git lfs install
git clone https://github.com/LegacyAI-FloydsLabs/FLOYD-The_Hole_Damn_SWEET.git
cd FLOYD-The_Hole_Damn_SWEET
git lfs pull
./scripts/build-installer.sh
sudo installer -pkg "dist/FLOYD-$(tr -d '[:space:]' < VERSION).pkg" -target /
open '/Applications/FLOYD Desktop Suite.app'
```

For an installation in your own account, use the ZIP produced by the same
build. It contains the identical application, with a complete file receipt:

```sh
./scripts/install-for-user.sh "dist/FLOYD-$(tr -d '[:space:]' < VERSION).app.zip"
open "$HOME/Applications/FLOYD Desktop Suite.app"
```

Opening FLOYD registers its two services for the current account and opens
its interface in the default browser. Existing account data in `~/.floyd`
is retained. Provider credentials belong to that account's Keychain and are
never copied from another user.

The clean macOS workflow builds and installs the package, checks every
packaged file against its receipt, observes the interface FLOYD opens, renders
all six registered surfaces and types a command into the IDE terminal.
It uploads screenshots and a result receipt alongside the installer and ZIP.
`scripts/verify-installed-application.sh` is restricted to that disposable
cloud account; do not run it against your everyday installation.

The package is unsigned unless `FLOYD_SIGN_IDENTITY` names a Developer ID
Installer certificate. The command-line installer above supports the unsigned
development package used by the clean-Mac workflow; sign release packages for
normal distribution.

For source development, install the root workspace with the pinned package
manager (`npx --yes pnpm@11.24.0 install --frozen-lockfile`). `qrencode` is
optional and is used only for local QR handoff rendering.

The runtime root defaults to `~/.floyd`. Any manual run can override it:

```sh
node apps/frame/server/frame-server.mjs   # frame shell on :13030
```

Normal operation is via the two persistent LaunchAgents (`com.floyd.frame`,
`com.floyd.core`) — surfaces then start on demand through the frame, no
per-surface agents. Fresh-machine adoption: `./scripts/new-world-bootstrap.sh`
(idempotent PASS/FAIL) or `npm run core:install` for Floyd Core alone.
Provider keys stay in the Vault's macOS Keychain storage. Managed applications
receive only persistent `fv_...` capabilities and loopback Vault addresses;
enter or rotate provider keys only in the Frame Keys panel.

## Status

- Testing: use `npm test` plus each managed surface's local suite; final
  receipts are produced from the current checkout rather than a stale count.
- Clean-Mac installation: the cloud-built 0.2.2 package passed the
  [installed-application check](https://github.com/LegacyAI-FloydsLabs/FLOYD-The_Hole_Damn_SWEET/actions/runs/33990940821):
  automatic browser opening, all six screens, a typed terminal command,
  persistent screens when switching apps, and both internal-browser extensions.
  Reboot survival and signed/notarized distribution remain separate checks.
- Credential authority: the Vault is the single in-FLOYD provider credential
  proxy, including HTTP and Google Live WebSocket transports.

## Policy

Only application runtime files are tracked. Planning docs, session logs,
reports, and dogfood output stay untracked. Testing and readiness are
summarized here, not in tracked side documents.
