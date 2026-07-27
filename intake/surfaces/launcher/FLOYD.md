# harness-launcher — FLOYD.md

**Version:** 1.7.2
**Initialized:** 2026-04-18
**Governance:** .supercache/ v1.7.2
**Port:** 11000 (claimed in port-registry.json)
**Drive:** Storage
**Path:** /Volumes/Storage/harness-launcher

> **Compliance Notice:** This file must match the template at
> `.supercache/templates/floyd-md-template.md`. If you are an agent reading
> this file and it is missing sections from the template, edit this file to
> add them. Preserve all project-specific content below. The template is the
> spec. This file is the implementation. Make them match.

---

## Agent Contract

You are working on **harness-launcher**, a Legacy AI project.

**This file (`FLOYD.md`) is the canonical project spec.** It is authoritative for project identity, stack, ports, build commands, environment variables, and project-specific rules. All agents — Floyd, Claude, or any model routed through the OhMyFloyd harness — read this file first.

**Some projects also have a `CLAUDE.md` adapter** alongside this file. That adapter is optional and applies only when Claude is the active agent. It does not duplicate anything here; it layers Claude-specific behavior and role guidance on top. If `CLAUDE.md` conflicts with `FLOYD.md` on project facts, `FLOYD.md` wins. See `.supercache/templates/claude-md-template.md` for the adapter spec.

### Before You Start

1. Read this file completely. Do not skim. Every section constrains your behavior.
2. **If you are Claude Code**: also read `CLAUDE.md` if it exists at the project root. It contains your role, division of labor with Floyd, and Claude-specific rules.
3. Read `.supercache/READONLY` — you MUST NOT write to `.supercache/`.
4. Read `SSOT/harness-launcher_SSOT.md` for current project state. Perform the Verification Sweep Protocol defined in `.supercache/contracts/document-management.md` for sections relevant to your task.
5. Read `Issues/harness-launcher_ISSUES.md` for open issues and blockers.
6. Read `.supercache/manifests/port-allocation-policy.yaml` — NEVER use port 3000, 5000, 8000, 8080, or any other forbidden port. This project uses port **11000**. Do not change it without Douglas Talley's explicit approval.
7. Read `.supercache/contracts/execution-contract.md` — this governs how you prove your work.
8. Read `.supercache/contracts/repo-structure.md` — canonical layout for this project's language, plus the migration workflow if structural changes are needed.
9. Read `.supercache/contracts/git-discipline.md` — pre-commit checklist, commit message standards, secret hygiene, and reputation guardrails.
10. Read `.supercache/contracts/document-management.md` — Anti-Cruft Rule, canonical document homes, SSOT verification sweep, reference materials tier.
11. Read `.supercache/contracts/repo-hygiene.md` — `.gitignore` baseline for this language, cleanup triggers, project root tidiness standards.
12. Read `.supercache/manifests/model-routing.yaml` — this tells you which LLM to use for what.

### Governance Location

```
.supercache/ → /Volumes/SanDisk1Tb/.supercache
```

This directory contains global templates, contracts, manifests, and routing config.
It is **READ-ONLY**. Do not create, modify, or delete any file there.

### Where You Write

| Location             | Purpose                                          | Example                                         |
|----------------------|--------------------------------------------------|-------------------------------------------------|
| `SSOT/`              | Project status, decisions, findings, verification | `SSOT/harness-launcher_SSOT.md`, `SSOT/decision-log.md` |
| `Issues/`            | Bugs, blockers, tasks, help-desk ledger          | `Issues/harness-launcher_ISSUES.md`, `Issues/0001-description.md` |
| `.floyd/`            | Agent working state, session logs, runtime cache | `.floyd/agent_log.jsonl`                        |
| Project source files | Your actual work                                 | Any file in the project tree not listed below   |

### Where You Do NOT Write

| Location          | Reason                                       |
|-------------------|----------------------------------------------|
| `.supercache/`    | Global governance — READ-ONLY for all agents |

---

## Project Identity

| Field                | Value                                                                   |
|----------------------|-------------------------------------------------------------------------|
| **Name**             | harness-launcher                                                        |
| **Purpose**          | Interactive web-based launcher for 15 CLI/TUI harnesses with real-time terminal emulation |
| **Primary Language** | JavaScript (ES2022, CommonJS)                                           |
| **Runtime**          | Node.js 16+                                                             |
| **Module System**    | CommonJS                                                                |
| **Framework**        | Express.js ^4.18.2                                                      |
| **Database**         | None                                                                    |
| **Port**             | **11000** — claimed in `/Volumes/SanDisk1Tb/SSOT/port-registry.json`    |
| **Repository**       | None — not yet initialized on GitHub                                    |
| **Current Phase**    | Active development — post-refactor                                     |

---

## Project Structure

```
harness-launcher/
├── src/
│   ├── server.js       # Express + WebSocket server, PTY session management
│   └── harnesses.js    # Shared harness registry — single source of truth (15 harnesses)
├── public/
│   └── index.html      # Dynamic UI: xterm.js terminal, harness cards fetched from /harnesses
├── tests/
│   ├── multi-harness-test.js
│   └── …
├── .github/workflows/
│   └── ci.yml          # GitHub Actions CI — start server, verify health + API, run tests
├── start.sh            # Production start script
├── package.json
├── .gitignore
├── LICENSE
├── FLOYD.md
├── README.md
├── SSOT/
│   └── harness-launcher_SSOT.md
├── Issues/
│   └── harness-launcher_ISSUES.md
└── .floyd/
    └── agent_log.jsonl
```

---

## Build & Verify Commands

| Action         | Command                          | Expected Result             |
|----------------|----------------------------------|-----------------------------|
| **Type check** | N/A — plain JavaScript           | N/A                         |
| **Build**      | N/A — no build step              | N/A                         |
| **Test**       | `npm test`                       | All 15 harnesses + error-recovery PASS |
| **Test:multi**  | `npm run test:multi`             | Multi-harness test only                  |
| **Test:errors** | `npm run test:errors`            | Error-recovery test only                 |
| **Test:single** | `npm run test:single <harness>`  | Test one harness (manual, 2.5s timeout)  |
| **Lint**       | N/A — no linter configured       | N/A                         |
| **Start**      | `PORT=11000 npm start`           | Server up on 127.0.0.1:11000 (set HOST=0.0.0.0 for LAN) |

### Verification sequence after any change:

```bash
npm install && npm test
```

---

## Port Allocation

| Port         | Service          | Status                              |
|--------------|------------------|-------------------------------------|
| **11000**    | HTTP + WS server | **CLAIMED** in `port-registry.json` |

**Rules:**
- This project runs on port **11000**. That port is claimed in `/Volumes/SanDisk1Tb/SSOT/port-registry.json`.
- Do not change the port without Douglas Talley's explicit approval.
- Do not bind to any port in the forbidden list (see `.supercache/manifests/port-allocation-policy.yaml`).
- Verify before starting: `lsof -i :11000` — if something else is bound, investigate before killing.

---

## Project-Specific Rules

| #   | Rule                                                                | Rationale                                                     |
|-----|---------------------------------------------------------------------|---------------------------------------------------------------|
| R1  | All 14 harnesses must be discoverable and executable                | Launcher is useless if any harness is missing or broken       |
| R2  | Process cleanup is mandatory — no orphaned PTY processes             | Orphaned shells leak resources and destabilize the host      |
| R3  | Terminal output is streamed line-by-line via xterm.js              | Buffered DOM updates eliminated in favor of xterm.js        |
| R4  | WebSocket server handles concurrent sessions without crashing       | Production use expects multiple simultaneous users           |
| R5  | All harness data lives in `src/harnesses.js` — single source of truth. Frontend fetches via `GET /harnesses`; backend validates against `VALID_HARNESS_NAMES`. Never hardcode harness names elsewhere | Eliminates R5 drift between frontend and backend |

---

## Known Patterns & Lessons

| Pattern                     | Trigger                                  | Fix                                                   | Confidence |
|-----------------------------|------------------------------------------|-------------------------------------------------------|------------|
| ws-connect-failure          | Second harness session fails with WS_ERROR | Resolved: WS is now connection-per-session; exponential-backoff reconnect handles silent disconnects | 1.0        |
| node-pty-build              | Fresh macOS install, no Xcode CLT        | Document `xcode-select --install` in README.md         | 1.0        |

---

## Environment Variables

| Variable          | Required        | Purpose               | Example               |
|-------------------|-----------------|-----------------------|-----------------------|
| `PORT`            | No              | HTTP server port      | `11000` (default)     |
| `HOST`            | No              | Bind address           | `127.0.0.1` (default; set `0.0.0.0` for LAN) |

---

## Execution Contract

Before claiming any task complete, provide:

1. **Exact action taken** — what you did, specifically
2. **Direct evidence** — file path + line, command + output, diff, or screenshot
3. **Verification result** — run the verification sequence above, all must exit 0
4. **Status** — mark COMPLETE only after steps 1-3 are proven

See `.supercache/contracts/execution-contract.md` for the full contract.

---

## Mandatory execution contract

For EACH requested item:
1) Show exact action taken
2) Show direct evidence (file/line/command/output)
3) Show verification result
4) Mark status only after proof

## Forbidden behaviors
- Declaring "done" without evidence
- Collapsing multiple requested items into one vague summary
- Skipping failed steps without explicit blocker report

## Required output structure
A) Requested items checklist
B) Per-item evidence ledger
C) Verification receipts
D) Completeness matrix (item -> done/blocked -> evidence)

## Hard gate
If any requested item has no evidence row, final status MUST be INCOMPLETE.
