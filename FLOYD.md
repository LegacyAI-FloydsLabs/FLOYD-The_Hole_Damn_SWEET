# FLOYD Workstation Repository Contract

**Version:** 1.8.0 (supersedes 1.7.2)
**Revised:** 2026-07-31, against the live machine

## What this is

FLOYD is Douglas's own unified workspace — the thing he uses instead of the
Claude desktop app. One app (the frame) holds his surfaces: the coding TUI,
his own IDE (not VS Code), the desktop surface for chat and multimedia
(image/video generation), and web terminals. One continuous session follows
him across all of them: start something in the TUI, pick it up in the IDE,
generate an image for the same project on the desktop surface.

He owns no LLM. The surfaces talk to any provider he chooses — Anthropic,
OpenAI, Google, Z.ai, MiniMax, whoever — through each provider's API. The
Vault exists to broker those provider keys to every surface so no surface
stores keys itself.

Anything in this repo that contradicts the two paragraphs above is stale and
should be corrected, not obeyed.

## How the machine actually runs it

- Two launchd agents own the always-on processes: `com.floyd.frame` (the
  shell, port 13030, plus the vault proxy on 13031) and `com.floyd.core`
  (the durable authority, port 41414, token-gated).
- **The runtime root defaults to `~/.floyd`.** Both agents run with
  `FLOYD_RUNTIME_ROOT` set appropriately. The code's built-in default is
  `~/.floyd`. Override with `FLOYD_RUNTIME_ROOT=/path/to/runtime`.
- **Surfaces start on demand, not at boot.** The frame spawns them when you
  open them (or via `POST http://127.0.0.1:13030/api/launch/<id>`), injecting
  their vault capabilities at spawn. Do not install per-surface LaunchAgents;
  that generation is retired (`scripts/start-admitted-surfaces.sh` is stamped
  superseded) and produced orphaned duplicates.

## Fixed decisions

- Source/control hub: this repo clone.
- Floyd Core is the sole durable ecosystem authority. Surfaces connect to
  Core and never own the engine, credentials, sessions, or policy directly.
- Upstream OpenCode is the managed coding engine, never a deep fork.
- **The first-party cockpit is retired.** The active unified surface is
  `apps/frame` plus the managed app surfaces declared in
  `apps/frame/registry.json` and `ecosystem/surfaces.json`.
- Provider routing: any provider added in the Frame Keys panel works. The
  default coding route is the GLM Coding Plan; MiniMax Token Plan is an
  explicit alternate. No silent pay-as-you-go fallback. Model catalogs are
  served LIVE by the vault broker (`GET /models` on 13031); static lists in
  `lib/vault-provider-catalog.mjs` are offline fallbacks only. Choosers show
  keyed providers only. GLM is the always-fallback when a selected provider
  has no key or hard-fails; fallbacks are marked (`x-floyd-fallback`) and
  shown to the user with the original failure, never silent.
- Vault keys live only in the macOS login Keychain under service
  `space.legacyai.floyd.vault`. No plaintext provider-key files. Managed apps
  receive only `fv_` capabilities and loopback Vault routes. Floyd runs only
  under the interactive login; unattended-daemon operation is out of scope.
- `ff` and `superfloyd` are untouched behavioral oracles.
- The v5 backup is corrupted forensic lineage, never a code donor.

## Non-negotiable protection

- Never edit, move, clean, reset, install into, or execute migrations against
  any legacy donor directory. Donor use starts with a verified independent
  copy; never hardlinks or writable symlinks into legacy paths.
- Never expose OpenCode, Floyd Core, browser control, MCP, shell, Git, or
  media providers publicly. Private overlay routes only (Tailscale is
  currently inactive; historical port claims for it remain in the registry).
  Public tunnels are explicit break-glass work.
- Quarantine, never delete. Ambiguous removals go to `quarantine/`.

## Surface identity and the "verified" flag

Core's `/api/surfaces` compares each running surface's self-reported
`{surface_id, source_root, source_commit}` against the admitted manifest in
`ecosystem/surfaces.json`. Surfaces stamp themselves with the live repo HEAD
(the frame deliberately strips stale commit env vars at spawn). When the repo
advances past the admitted commit, every surface reports verified:false with
"Health responded without the required admitted source identity." That is the
admission gate working, not a crash: re-admitting means reviewing the tree
and updating `integration.commit` in the manifest — a deliberate trust
decision, not something to bypass by weakening the check.

## Current plans and history

- Active plans live in `plans/` with an index at `plans/INDEX.md`.
- `.planning/` holds dated historical working notes (kept for archaeology,
  not authority).

## Truth protocol

Label work as proposed, implemented, or runtime-verified. A test must show
real command output before claiming pass. Every implementation turn ends with
exact changes, commands, output, verification, and remaining work.

## Claimed ports

| Port | Service | State |
|---|---|---|
| 13030 | FLOYD frame shell server | live |
| 13031 | FLOYD vault credential proxy (loopback only) | live |
| 13010 | floyd-desktop (frame-managed, intake/surfaces/desktop) | live |
| 13011 | floyd-desktop Chrome extension MCP bridge (loopback only) | live |
| 13012 | cursem-ide (frame-managed, intake/surfaces/ide) | live |
| 13013 | Floyd WS Terminal — the frame's permanent terminal (frame-managed, intake/surfaces/pty) | live |
| 13014 | harness-launcher (frame-managed, intake/surfaces/launcher) | live |
| 13022 | floyd-code-cli (frame-managed pty copy, SHELL=ff) | on demand |
| 13023 | ohmyfloyd (frame-managed pty copy, SHELL=floydcode) | on demand |
| 13032 | frame-internal-browser-cdp (loopback only) | on demand |
| 13035 | remote-portal edge relay (apps/remote-portal) | inactive until configured |
| 41414 | floyd-core (loopback only, token-gated) | live |
| 8451-8455 | Reserved HTTPS remote ports for iframe apps | inactive — no private overlay configured |
