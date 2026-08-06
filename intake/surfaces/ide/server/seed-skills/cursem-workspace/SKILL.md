---
name: cursem-workspace
description: Teaches agents how to operate inside a CURSEM IDE workspace — the confined filesystem API, agent threads/runs/events, the allowlisted task runner, Git operations, context search, and MCP tool brokering. Use whenever an agent runs inside CURSEM and needs to read or write workspace files, run project tasks, or persist chat state.
---

# CURSEM Workspace APIs

CURSEM exposes a trusted loopback HTTP host. Every route is same-origin under `/api/*` and every filesystem path is confined to the approved workspace root by the server's `WorkspaceBoundary` — relative paths resolve against the workspace root, absolute paths outside it are rejected with 403, and symlink escapes are rejected via `realpath`.

## Hard rules

- Never attempt paths outside the workspace root; they will fail with 403 by design.
- Never handle provider credentials. All LLM traffic goes through the Vault credential proxy; no keys exist in the app, the workspace, or the renderer.
- Never invent shell commands. The task runner executes an allowlisted executable with an argument vector — no shell, pipes, redirects, or substitutions.
- Git mutations (commit, push) may be refused with 403 when the repository is Proofline-governed; respect that signal and stop.

## Filesystem

- `GET /api/fs/read?path=<p>` → `{ content }` (text, UTF-8)
- `GET /api/fs/read-binary?path=<p>` → `{ name, size, mime, data(base64) }` (≤ 64 MB)
- `POST /api/fs/write` `{ path, content }` → writes a text file
- `GET /api/fs/list?path=<p>` → `{ items: [{ name, path, type: file|dir|symlink, size, mtimeMs }] }`
- `GET /api/fs/stat?path=<p>` → `{ path, type, size, mtimeMs, mode }`
- `POST /api/fs/mkdir` `{ path }`, `POST /api/fs/rename` `{ from, to }`, `DELETE /api/fs/remove?path=<p>`
- `GET /api/fs/watch?path=<p>` → SSE stream of `{ type: rename|modify, path }`

## Agent state (threads, runs, events)

Durable chat state lives in per-workspace SQLite behind these routes:

- `GET /api/agent/threads?limit=` / `POST /api/agent/threads { title }`
- `GET /api/agent/thread?id=`
- `POST /api/agent/messages { threadId, role, content, metadata? }`
- `POST /api/agent/runs { ... }`, `GET /api/agent/run?id=`, `POST /api/agent/run/update { runId, status, summary }`
- `POST /api/agent/events { runId, type, payload }`
- `POST /api/agent/patch/preview` / `POST /api/agent/patch/apply` — checkpoint-gated patch review and apply
- `GET /api/agent/checkpoints`, `POST /api/agent/checkpoints/restore`
- `GET|POST /api/agent/memories`, `DELETE /api/agent/memories?id=`

## Running tasks

- `GET /api/tasks` → discovered task vectors (`package:<script>`, `cargo:test`, `go:test`, `pytest`, `make:<target>`) with executable + args.
- `POST /api/agent/task { executable, args, cwd?, timeoutMs? }` → `{ stdout, stderr, exitCode, signal, durationMs }`.
  - Allowlisted executables only: `node, npm, npx, pnpm, yarn, bun, git, rg, tsc, vite, vitest, pytest, python3, cargo, rustc, go, make`.
  - `git` here is read-only (`status, diff, log, show, grep, ls-files, rev-parse, branch`).
  - `cwd` is confined to the workspace; timeout is clamped to 1–120 s.

## Git

`GET /api/git/status|diff|log|branches?path=` and `POST /api/git/stage|unstage|commit|fetch|pull|push|branch|checkout` with `{ repoPath, ... }`. All repo paths are workspace-confined.

## Context and rules

- `GET /api/context/status`, `POST /api/context/refresh`
- `POST /api/context/search { query, limit? }`, `POST /api/context/resolve { selectors, budgetChars? }`
- `GET /api/context/rules?path=` — scoped rule files that apply to a path

## MCP tools

- `GET /api/mcp/servers` → configured servers (never auto-connected)
- `POST /api/mcp/connect { id }` / `POST /api/mcp/disconnect { id }`
- `GET /api/mcp/tools?id=` / `POST /api/mcp/call { id, name, arguments }`

## Skills

- `GET /api/skills/index` — merged skills catalog
- `GET /api/skills/installed` — `{ skills: [{ slug, name, target, path, content? }] }`; entries installed into the `cursem` target (`.cursem/skills`) include their SKILL.md body and are injected into the agent's system prompt — treat them as active instructions.
- `POST /api/skills/install { entry, targetId }` / `POST /api/skills/uninstall { slug, target }`
