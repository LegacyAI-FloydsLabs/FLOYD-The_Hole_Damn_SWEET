# CURSEM IDE

CURSEM is a standalone, local-first coding workbench for macOS. It combines a Monaco editor, real workspace access, system Git, authenticated TerminalOne sessions, shared language servers, Node debugging, and a credential-proxied coding partner. It has no runtime dependency on Floyd and no required subscription.

## Start

Requirements: Node.js 22 or newer, Git, and macOS for the native folder picker. Node 22 provides the repository-native SQLite runtime used for durable Agent history and checkpoints.

```bash
npm install
npm run prepare:runtime
npm start -- --workspace /absolute/path/to/project
```

`prepare:runtime` builds the versioned UI once. Normal `npm start` launches those assets without rebuilding, starts CURSEM on a random loopback port, starts an authenticated TerminalOne child on another loopback port, and prints the browser URL. Set `CURSEM_PORT=5188` when a stable port is preferred.

On macOS, `npm run package:macos` produces `artifacts/CURSEM.app` with its own Node runtime and production modules. It is ad-hoc signed for local execution, opens a native project-folder picker, launches without a terminal, and writes local launcher diagnostics under `~/Library/Application Support/CURSEM/logs`. Distribution notarization requires an Apple Developer signing identity and is not implied by the local package.

On every normal startup, CURSEM connects to the existing loopback credential proxy. CURSEM reads only an owner-only app capability token; the proxy owns provider keys, OAuth refresh, account rotation, and provider requests. No provider credential is copied into CURSEM, written to `.env.local`, placed in the browser, or returned by the proxy.

The compatibility defaults are `http://127.0.0.1:4000` and
`~/.omp/auth-gateway.token`. They can be replaced without changing CURSEM by
setting `CURSEM_CREDENTIAL_PROXY_URL` and
`CURSEM_CREDENTIAL_PROXY_TOKEN_FILE`; this is the seam the JCODE credential
proxy uses during cutover. A provider key may still be entered for an
intentional one-off, memory-only request by disabling **Use credential proxy**.

## Daily-driver capabilities

- Real filesystem explorer, recursive search, autosave, crash-buffer recovery, native folder selection, external-change watching, and path/symlink confinement.
- Monaco tabs, syntax intelligence, completion, hover, definitions, references, rename, formatting, diagnostics, diff view, minimap, folding, find/replace, and configurable workbench preferences.
- One shared stdio language-server process per language family instead of one process per tab. TypeScript/JavaScript, JSON, HTML/CSS, Python, and Shell servers ship with the project; `rust-analyzer` is used automatically when installed on `PATH`.
- Real system Git status, diffs, stage/unstage, commits, history, branches, fetch, fast-forward pull, and confirmation-gated push.
- Authenticated loopback TerminalOne with multiple resumable PTY sessions, resize, clipboard, links, and search.
- Trusted Node inspector adapter with launch, pause, continue, step-in/over/out, stack frames, variables, and disconnect.
- Ask and edit AI modes with durable local conversation history. Edit mode supports typed multi-file proposals, server-frozen hashes, file/hunk selection, atomic application, conflict detection, and restart-safe SQLite checkpoints.
- Local Git-aware repository context with sensitive-file exclusion, deterministic path/symbol/text retrieval, explicit `@file`, `@folder`, and `@symbol` selectors, inspectable context budgets, scoped `AGENTS.md`/`CLAUDE.md`/Cursor/CURSEM rules, and user-approved project memory.
- Foreground Agent mode with iterative search/read/list/rules/Git-diff/task tools, append-only tool evidence, bounded no-shell task execution, explicit task approval, provider/task cancellation, and mid-stream steering.
- CURSEM Tab provider-routed ghost text with prefix/suffix context and cancellation, plus `Cmd/Ctrl+K` selection editing with preview, atomic apply, conflict protection, and a durable checkpoint.
- Permissioned MCP support for `.cursem/mcp.json`, `.cursor/mcp.json`, and user configuration, with explicit activation, stdio and Streamable HTTP transports, redacted secrets, tool inspection, per-call approval, Agent integration, and process/session cleanup.
- Inspectable manual, low-cost-first, measured-latency, and resilient routing policies. Provider fallback is limited to proxy-managed requests, only occurs before text is emitted, and never reuses a user key at another vendor.
- Read-only Cursor and VS Code profile migration that applies only supported workbench preferences, strips unrelated/secret settings, and explicitly classifies keybindings, snippets, and extensions without claiming extension-host compatibility.
- Run & Debug task discovery for package scripts, Pytest, Cargo, Go, Make, and safely translatable `.vscode/tasks.json` entries; task vectors are shell-free, confirmation-gated, cancellable, and their exact output can be attached visibly to Agent context.
- Deferred Monaco, TerminalOne, AI, Git, Debug, and integrations chunks with a 500 KB entry-bundle gate; normal startup serves prebuilt assets and `npm run benchmark:startup` records repeatable loopback-ready timing.
- Sixteen semantic themes, bundled fonts, command palette, keyboard shortcuts, resizable panels, accessibility semantics, and reduced-motion support.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for trust boundaries and [docs/ROUTING_ENGINE.md](docs/ROUTING_ENGINE.md) for the provider protocol.

The evidence-based comparison with Cursor and the prioritized parity-plus implementation backlog live in [docs/CURSOR_UX_PARITY_PLAN.md](docs/CURSOR_UX_PARITY_PLAN.md).

## Verification

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm audit --audit-level=high
```

The AI routing core is intentionally repository-native ESM and uses only Node/web platform APIs. UI/editor dependencies do not enter that trust boundary.
