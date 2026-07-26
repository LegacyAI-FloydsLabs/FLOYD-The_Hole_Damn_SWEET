# FLOYD Workstation Repository Contract

**Version:** 1.7.2
**Governance:** .supercache/ v1.7.2

## Mission

Build one private, persistent FLOYD workstation: coding, Browork, terminal, Git,
browser, mobile/SSH, multimedia, skills, memory, agents, and artifacts over one
durable authority.

## Fixed decisions

- Source/control hub: `/Volumes/Storage/FLOYD_WORKSTATION`.
- Runtime/media hub: `/Volumes/Storage/FLOYD_RUNTIME`.
- Floyd Core is the sole durable ecosystem authority.
- Upstream OpenCode is the managed coding engine, never a deep fork by default.
- **The first-party cockpit is retired.** The active unified surface is
  `apps/frame` plus the managed app surfaces declared in `apps/frame/registry.json`
  and `ecosystem/surfaces.json`.
- `ff` and `superfloyd` are untouched behavioral oracles.
- The v5 backup is corrupted forensic lineage, never a code donor.
- GLM Coding Plan is the initial coding route; MiniMax Token Plan is an explicit
  alternate after region/entitlement discovery. No silent PAYG fallback.

## Non-negotiable protection

- Never edit, move, clean, reset, install into, or execute migrations against
  any legacy donor directory.
- Any donor use starts with a verified independent copy. Never use hardlinks or
  writable symlinks into legacy paths.
- Never expose OpenCode, Floyd Core, browser control, MCP, shell, Git, or media
  providers publicly. Private overlay routes only (Tailscale has been removed
  from this system); public tunnels are explicit break-glass work.

## Authoritative planning documents

1. `FABLE5_HANDOFF.md` — immediate implementation mission.
2. `FLOYD_ECOSYSTEM_BLUEPRINT.md` — selected architecture and roadmap.
3. `findings.md` — evidence and donor dispositions.
4. `task_plan.md` — constraints and acceptance gates.
5. `progress.md` — evidence log and continuation status.

## Truth protocol

Label work as proposed, implemented, or runtime-verified. A test must show real
command output before claiming pass. Every implementation turn ends with exact
changes, commands, output, verification, and remaining work.

## Claimed ports (recorded in /Volumes/SanDisk1Tb/SSOT/port-registry.json)

| Port | Service |
|---|---|
| 13030 | FLOYD frame shell server |
| 13010 | floyd-desktop (frame-managed, intake/surfaces/desktop) |
| 13012 | cursem-ide (frame-managed, intake/surfaces/ide) |
| 13013 | terminalone (frame-managed PTY) |
| 13014 | harness-launcher (frame-managed, intake/surfaces/launcher) |
| 13022 | floyd-code-cli (frame-managed pty copy, SHELL=ff) |
| 13023 | ohmyfloyd (frame-managed pty copy, SHELL=floydcode) |
| 8451-8455 | Reserved HTTPS remote ports for the five iframe apps (currently inactive — no private overlay configured) |
