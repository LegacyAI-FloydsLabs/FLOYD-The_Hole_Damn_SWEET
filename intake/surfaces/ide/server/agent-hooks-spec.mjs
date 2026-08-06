// =============================================================================
// Agent hook spec — the per-CLI declarations that turn the agent CLIs'
// hook/extension/plugin surfaces into ONE normalized push event stream.
// Direct port of Cate 1.5.3 src/shared/agentHooks.ts plus the registry/resume
// parts of src/shared/agents.ts (MIT), renamed CATE_* → CURSEM_*.
//
// Each agent entry declares (a) WHICH workspace-scoped files CURSEM writes to
// inject its hook bridge and (b) how that CLI's raw hook payload normalizes
// into an AgentHookEvent. Adding a CLI is one AGENTS entry plus one
// AGENT_HOOK_SPECS entry.
//
// Pure functions, no Electron, no fs — unit-testable. Imported by the backend
// capability (server/agent-hooks.mjs), which owns all filesystem effects.
// =============================================================================

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Env contract — planted on every PTY through the TerminalOne env channel;
// echoed back by hooks (hook handlers inherit the PTY env, which is the
// terminal↔event correlation). All three pass TerminalOne's CURSEM_* allowlist.
// ---------------------------------------------------------------------------

export const CURSEM_HOOK_ENDPOINT_ENV = 'CURSEM_HOOK_ENDPOINT';
export const CURSEM_HOOK_TOKEN_ENV = 'CURSEM_HOOK_TOKEN';
export const CURSEM_TERMINAL_ID_ENV = 'CURSEM_TERMINAL_ID';

// ---------------------------------------------------------------------------
// Agent registry (port of src/shared/agents.ts, minus skills targets)
// ---------------------------------------------------------------------------

export const AGENTS = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    command: 'claude',
    matchProcess: (n) => n === 'claude' || n === 'claude-code' || n.startsWith('claude'),
    resumeArgs: (sid) => ['--resume', sid],
  },
  {
    id: 'codex',
    displayName: 'Codex',
    command: 'codex',
    matchProcess: (n) => n === 'codex',
    resumeArgs: (sid) => ['resume', sid],
  },
  // The install script links ~/.local/bin/cursor-agent; the CLI keeps the
  // invoked name as its process title (comm is the full launcher path, which
  // the process scan basenames), so both spellings show up in the wild.
  {
    id: 'cursor',
    displayName: 'Cursor',
    command: 'cursor-agent',
    matchProcess: (n) => n === 'cursor-agent' || n === 'cursor',
    // --resume ADOPTS an unknown id (fresh chat under that id, exit 0) rather
    // than failing — a stale stamp degrades to a fresh session, never a wrong one.
    resumeArgs: (sid) => ['--resume', sid],
  },
  // xAI's Grok Build. The npm launcher (@xai-official/grok) execs a versioned
  // binary out of ~/.grok/bin — the process scan basenames it, so the
  // versioned spelling shows up alongside the plain one.
  {
    id: 'grok',
    displayName: 'Grok',
    command: 'grok',
    matchProcess: (n) => n === 'grok' || /^grok-\d/.test(n),
    // --resume ERRORS on an id with no session on disk (pinned live by Cate),
    // so a stale stamp falls back to a plain shell instead of silently opening
    // a fresh chat.
    resumeArgs: (sid) => ['--resume', sid],
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    command: 'opencode',
    matchProcess: (n) => n === 'opencode',
    resumeArgs: (sid) => ['--session', sid],
  },
  // @earendil-works/pi-coding-agent — runs as the `pi` binary.
  {
    id: 'pi',
    displayName: 'PI Agent',
    command: 'pi',
    matchProcess: (n) => n === 'pi',
    // pi's --resume is an interactive picker; --session takes an exact id.
    resumeArgs: (sid) => ['--session', sid],
  },
];

/** The agent whose process name matches, or null if none. Matching is
 *  case-insensitive (the name is lowercased before the rules run). */
export function matchAgentDef(procName) {
  const lower = String(procName || '').toLowerCase();
  for (const agent of AGENTS) {
    if (agent.matchProcess(lower)) return agent;
  }
  return null;
}

/** The launch command for an agent id, or null if the id is unknown/empty. */
export function launchCommandForAgent(id) {
  return AGENTS.find((a) => a.id === id)?.command ?? null;
}

// Session-resume (AgentDef.resumeArgs) builds the command typed into a restored
// terminal's shell to re-attach the agent to the session it was running at save
// time. The session id is interpolated into a shell command line, so it is
// validated to be a bare token first (uuids / opencode ses_* ids; never
// quoting-sensitive).
//
// First char must be alphanumeric: session ids originate from hook posts any
// terminal process can forge, and a dash-led "id" (`--dangerously-skip-
// permissions`) would otherwise be joined into the resume command as a flag.
// Real ids are uuids / opencode `ses_*` — never dash-led.
export const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The full shell command that resumes `sessionId` for `agentId`, or null when
 *  the agent is unknown / can't resume by id (or the id isn't a bare token). */
export function resumeCommandForAgent(agentId, sessionId) {
  const def = AGENTS.find((a) => a.id === agentId);
  if (!def?.resumeArgs || !SAFE_SESSION_ID.test(sessionId)) return null;
  return [def.command, ...def.resumeArgs(sessionId)].join(' ');
}

// ---------------------------------------------------------------------------
// The one normalized event
// ---------------------------------------------------------------------------

// kind ∈ session-start | session-end | turn-start | turn-end | permission-wait
// | turn-resume (a blocked permission-wait resolved and the turn is in flight
// again; also fires on every ordinary tool call for claude/codex — consumers
// treat it as an idempotent "the turn is running" re-assertion).

// ---------------------------------------------------------------------------
// Injection declarations
// ---------------------------------------------------------------------------

/**
 * Per-agent injection preference for a workspace's PROJECT hook files.
 *  - 'auto' (default): inject only when the agent's own config folder already
 *    exists in the repo (e.g. .claude, .codex) — a "this agent is relevant
 *    here" signal that avoids littering unrelated repos.
 *  - 'on': always inject, even in a repo with no such folder yet.
 *  - 'off': never inject, and strip any hook entries CURSEM previously wrote.
 * The shared CURSEM_HOOK_* env (endpoint/token/terminal id) is planted on
 * every PTY regardless — it leaves no repo trace, and a hook file that never
 * gets written simply never reads it.
 */
export function resolveAgentHookMode(config, agentId) {
  return config?.[agentId] ?? 'auto';
}

/** Marker every generated bridge/wrapper path contains — how the project-file
 *  merge recognizes (and refreshes) CURSEM's own entries when the bridge path
 *  changes (the hooks dir is stable across boots, but an app relocation or a
 *  file written by an older per-boot-dir version leaves stale paths behind). */
export const CURSEM_HOOK_MARKER = 'cursem-hook';

const str = (v) => (typeof v === 'string' ? v : null);

// ---------------------------------------------------------------------------
// Shared {hooks: {<Event>: [groups]}} file merge — claude's
// settings.local.json and codex's hooks.json use the same shape.
// ---------------------------------------------------------------------------

/**
 * Merge OUR one-command group into every tracked event of a SHARED hooks file.
 * Merge, never clobber: the file also carries user content (claude's "always
 * allow" grants, a user's own codex hooks), so every user field and every user
 * hook group is preserved. Only groups consisting solely of STALE CURSEM
 * bridge entries (recognized by the marker) are dropped, then the fresh group
 * is appended per tracked event. Returns the new content, or null to leave the
 * file untouched (unparseable, or already correct).
 */
export function mergeSharedHooksFile(existing, events, oursGroup) {
  if (existing === null) {
    return JSON.stringify({ hooks: Object.fromEntries(events.map((e) => [e, [oursGroup()]])) }, null, 2) + '\n';
  }
  let parsed;
  try {
    parsed = JSON.parse(existing);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  } catch {
    return null;
  }
  // The !Array.isArray guard is load-bearing: a `"hooks": []` value passes
  // the typeof-object check, and named keys assigned onto an array are
  // silently dropped by JSON.stringify — the file would look merged but
  // carry no hooks.
  const hooks =
    typeof parsed.hooks === 'object' && parsed.hooks !== null && !Array.isArray(parsed.hooks)
      ? parsed.hooks
      : {};
  for (const event of events) {
    const kept = [];
    for (const group of Array.isArray(hooks[event]) ? hooks[event] : []) {
      if (typeof group !== 'object' || group === null) {
        kept.push(group);
        continue;
      }
      const entries = Array.isArray(group.hooks) ? group.hooks : [];
      const filtered = entries.filter(
        (h) => !(typeof h?.command === 'string' && h.command.includes(CURSEM_HOOK_MARKER)),
      );
      if (entries.length > 0 && filtered.length === 0) continue; // group was ours
      kept.push(filtered.length === entries.length ? group : { ...group, hooks: filtered });
    }
    hooks[event] = [...kept, oursGroup()];
  }
  const out = JSON.stringify({ ...parsed, hooks }, null, 2) + '\n';
  return out === existing ? null : out;
}

/**
 * Inverse of mergeSharedHooksFile: drop OUR bridge entries from every tracked
 * event, preserving every user entry and field, and prune events left empty by
 * the removal. Returns { content } when anything of ours was removed, or null
 * when the file has nothing of ours / is unparseable (leave it alone). Never
 * deletes the file — it is shared with the user's own hooks.
 */
export function stripSharedHooksFile(existing, events) {
  let parsed;
  try {
    parsed = JSON.parse(existing);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  } catch {
    return null;
  }
  if (typeof parsed.hooks !== 'object' || parsed.hooks === null || Array.isArray(parsed.hooks)) return null;
  const hooks = parsed.hooks;
  let changed = false;
  for (const event of events) {
    if (!Array.isArray(hooks[event])) continue;
    const kept = [];
    for (const group of hooks[event]) {
      if (typeof group !== 'object' || group === null) {
        kept.push(group);
        continue;
      }
      const entries = Array.isArray(group.hooks) ? group.hooks : [];
      const filtered = entries.filter(
        (h) => !(typeof h?.command === 'string' && h.command.includes(CURSEM_HOOK_MARKER)),
      );
      if (entries.length > 0 && filtered.length === 0) {
        changed = true; // group was purely ours — drop it
        continue;
      }
      if (filtered.length !== entries.length) {
        changed = true;
        kept.push({ ...group, hooks: filtered });
      } else {
        kept.push(group);
      }
    }
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (!changed) return null;
  return { content: JSON.stringify({ ...parsed, hooks }, null, 2) + '\n' };
}

/** The repo-local config folder whose presence gates 'auto' injection for one
 *  agent (`.claude`, `.codex`, `.cursor`, `.opencode`, `.pi`), or null for an
 *  agent that writes no project files. Derived from the agent's first project
 *  file so it stays in lockstep with the spec. */
export function agentHookFolder(agentId) {
  const rel = AGENT_HOOK_SPECS[agentId]?.projectFiles?.[0]?.relPath;
  if (!rel) return null;
  return rel.split('/')[0];
}

// ---------------------------------------------------------------------------
// claude — hooks ride in <workspace>/.claude/settings.local.json (project
// scope, merged by claude over user settings; same file whether claude is in
// TUI or -p mode). JSON payload on hook stdin;
// session_id/transcript_path/cwd on every event.
// ---------------------------------------------------------------------------

const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'PostToolUse', 'Stop', 'SessionEnd'];

const claudeSpec = {
  projectFiles: [
    {
      relPath: '.claude/settings.local.json',
      // Shared with claude's own writes (its "always allow" permission grants
      // land in this file) — merged, never clobbered.
      build: (existing, ctx) =>
        mergeSharedHooksFile(existing, CLAUDE_EVENTS, () => ({
          hooks: [{ type: 'command', command: ctx.bridgeCommand }],
        })),
      strip: (existing) => stripSharedHooksFile(existing, CLAUDE_EVENTS),
    },
  ],
  normalize: (p) => {
    const base = {
      sessionId: str(p.session_id),
      cwd: str(p.cwd) ?? undefined,
      transcriptPath: str(p.transcript_path) ?? undefined,
    };
    switch (p.hook_event_name) {
      case 'SessionStart': return { kind: 'session-start', ...base };
      case 'UserPromptSubmit': return { kind: 'turn-start', ...base };
      // Fires after EVERY executed tool call; the one after a permission-wait
      // is the approval resolution (denial produces no PostToolUse — the turn
      // just Stops).
      case 'PostToolUse': return { kind: 'turn-resume', ...base };
      case 'Stop': return { kind: 'turn-end', ...base };
      case 'SessionEnd': return { kind: 'session-end', ...base };
      case 'Notification':
        // permission_prompt = blocked on tool approval; idle_prompt (and any
        // future notification type) is not a tracked state — drop it.
        return p.notification_type === 'permission_prompt' ? { kind: 'permission-wait', ...base } : null;
      default: return null;
    }
  },
};

// ---------------------------------------------------------------------------
// codex — hooks ride in <project>/.codex/hooks.json (repo scope, discovered
// by codex itself). Codex loads project hooks ONLY from a folder the user
// trusts, and unknown hooks get a ONE-TIME interactive review prompt
// (non-interactive runs silently skip them); on "trust", codex persists the
// grant in ITS OWN user state, keyed by the hook source path and a hash of
// the handler identity. That trust key is why the bridge command path must
// stay stable across app restarts (see the stable hooks dir in
// server/agent-hooks.mjs) — a churning path would re-prompt "modified since
// last trusted" on every boot.
// ---------------------------------------------------------------------------

/** sha256 of codex's canonical handler identity — the recipe codex checks a
 *  hooks.state trusted_hash against. Product code no longer plants trust (the
 *  user grants it once in codex's own review prompt). */
export function codexTrustedHash(label, command, timeout) {
  const identity =
    `{"event_name":${JSON.stringify(label)},"hooks":[{"async":false,` +
    `"command":${JSON.stringify(command)},"timeout":${timeout},"type":"command"}]}`;
  return 'sha256:' + createHash('sha256').update(identity).digest('hex');
}

/** hooks.json event keys (CamelCase). Codex's own trust-state keys use
 *  snake_case labels of these same events. */
const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Stop'];

const CODEX_HOOK_TIMEOUT = 60;

const codexSpec = {
  projectFiles: [
    {
      relPath: '.codex/hooks.json',
      // Shared with the user's own codex hooks — merged, never clobbered.
      build: (existing, ctx) =>
        mergeSharedHooksFile(existing, CODEX_EVENTS, () => ({
          hooks: [{ type: 'command', command: ctx.bridgeCommand, timeout: CODEX_HOOK_TIMEOUT }],
        })),
      strip: (existing) => stripSharedHooksFile(existing, CODEX_EVENTS),
    },
  ],
  normalize: (p) => {
    const base = {
      sessionId: str(p.session_id),
      cwd: str(p.cwd) ?? undefined,
      transcriptPath: str(p.transcript_path) ?? undefined,
    };
    switch (p.hook_event_name) {
      case 'SessionStart': return { kind: 'session-start', ...base };
      case 'UserPromptSubmit': return { kind: 'turn-start', ...base };
      case 'Stop': return { kind: 'turn-end', ...base };
      case 'PermissionRequest': return { kind: 'permission-wait', ...base };
      // Fires after EVERY executed tool call; the one after a PermissionRequest
      // is the approval resolution (denial produces no PostToolUse).
      case 'PostToolUse': return { kind: 'turn-resume', ...base };
      // SessionEnd never fires (pinned live by Cate) — no mapping on purpose.
      default: return null;
    }
  },
};

// ---------------------------------------------------------------------------
// cursor — JSON-on-stdin hooks configured in <workspace>/.cursor/hooks.json
// (project scope; schema differs from the claude/codex shared shape:
// {version: 1, hooks: {<event>: [{command}]}}). session_id (= conversation_id)
// on every event; payload cwd is often "" — workspace_roots[0] is the real
// join key.
//
// NO permission-wait mapping on purpose: cursor has no dedicated permission
// hook event (pinned live by Cate). beforeShellExecution fires before EVERY
// shell command — auto-approved or prompted alike, and before the command
// RUNS — so mapping it would flag every approved long-running command as
// "waiting". During a real approval prompt cursor therefore shows 'running'
// until the user answers; postToolUse (turn-resume) re-asserts afterwards.
// ---------------------------------------------------------------------------

const CURSOR_EVENTS = ['sessionStart', 'beforeSubmitPrompt', 'postToolUse', 'stop', 'sessionEnd'];

const cursorSpec = {
  projectFiles: [
    {
      relPath: '.cursor/hooks.json',
      // Shared with the user's own cursor hooks — merged, never clobbered.
      // Not mergeSharedHooksFile: cursor's per-event entries are flat
      // [{command}] handlers, not {matcher, hooks: [...]} groups.
      build: (existing, ctx) => {
        const ours = () => ({
          version: 1,
          hooks: Object.fromEntries(CURSOR_EVENTS.map((e) => [e, [{ command: ctx.bridgeCommand }]])),
        });
        if (existing === null) return JSON.stringify(ours(), null, 2) + '\n';
        let parsed;
        try {
          parsed = JSON.parse(existing);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
        } catch {
          return null;
        }
        // The !Array.isArray guard is load-bearing (same bug class as the
        // shared merge): a `"hooks": []` value passes typeof-object, and named
        // keys assigned onto an array vanish in JSON.stringify.
        const hooks =
          typeof parsed.hooks === 'object' && parsed.hooks !== null && !Array.isArray(parsed.hooks)
            ? parsed.hooks
            : {};
        for (const event of CURSOR_EVENTS) {
          const kept = (Array.isArray(hooks[event]) ? hooks[event] : []).filter(
            (h) => !(typeof h?.command === 'string' && h.command.includes(CURSEM_HOOK_MARKER)),
          );
          hooks[event] = [...kept, { command: ctx.bridgeCommand }];
        }
        const out = JSON.stringify({ version: parsed.version ?? 1, ...parsed, hooks }, null, 2) + '\n';
        return out === existing ? null : out;
      },
      strip: (existing) => {
        let parsed;
        try {
          parsed = JSON.parse(existing);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
        } catch {
          return null;
        }
        if (typeof parsed.hooks !== 'object' || parsed.hooks === null || Array.isArray(parsed.hooks)) return null;
        const hooks = parsed.hooks;
        let changed = false;
        for (const event of CURSOR_EVENTS) {
          if (!Array.isArray(hooks[event])) continue;
          const kept = hooks[event].filter(
            (h) => !(typeof h?.command === 'string' && h.command.includes(CURSEM_HOOK_MARKER)),
          );
          if (kept.length !== hooks[event].length) changed = true;
          if (kept.length === 0) delete hooks[event];
          else hooks[event] = kept;
        }
        if (!changed) return null;
        return { content: JSON.stringify({ ...parsed, hooks }, null, 2) + '\n' };
      },
    },
  ],
  normalize: (p) => {
    const roots = Array.isArray(p.workspace_roots) ? p.workspace_roots : [];
    const base = {
      // session_id and conversation_id are the same uuid on every observed
      // event; keep the fallback in case one spelling disappears in an update.
      sessionId: str(p.session_id) ?? str(p.conversation_id),
      cwd: str(roots[0]) ?? undefined,
      transcriptPath: str(p.transcript_path) ?? undefined,
    };
    switch (p.hook_event_name) {
      case 'sessionStart': return { kind: 'session-start', ...base };
      case 'beforeSubmitPrompt': return { kind: 'turn-start', ...base };
      // Fires after EVERY executed tool call — the idempotent "turn is
      // running" re-assertion (and the only turn signal print mode has).
      case 'postToolUse': return { kind: 'turn-resume', ...base };
      case 'stop': return { kind: 'turn-end', ...base };
      case 'sessionEnd': return { kind: 'session-end', ...base };
      default: return null;
    }
  },
};

// ---------------------------------------------------------------------------
// pi — in-process extension auto-discovered from <cwd>/.pi/extensions/*.ts
// (project scope, `--no-extensions` disables). CURSEM owns cursem-hook.ts
// outright; it self-gates on the CURSEM env vars, so it is inert if committed
// and loaded by a teammate's pi. Identity from ctx.sessionManager on every
// event; agent_start/agent_end bracket each turn. The extension posts to the
// backend itself (fetch), so no bridge process runs.
// ---------------------------------------------------------------------------

const PI_EXTENSION_SOURCE = `// cursem-hook — generated by CURSEM IDE (agent hook injection); do not edit.
// Inert outside CURSEM terminals: it no-ops unless the CURSEM_HOOK_* env vars are set.
const ENDPOINT = process.env.${CURSEM_HOOK_ENDPOINT_ENV};
const TOKEN = process.env.${CURSEM_HOOK_TOKEN_ENV};
export default function (pi: any) {
  if (!ENDPOINT || !TOKEN) return;
  const post = (event: string, ctx: any) => {
    let sessionId: string | undefined;
    let sessionFile: string | undefined;
    try {
      sessionId = ctx?.sessionManager?.getSessionId?.();
      sessionFile = ctx?.sessionManager?.getSessionFile?.();
    } catch {}
    fetch(ENDPOINT + "/hook", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
      body: JSON.stringify({
        agentId: "pi",
        terminalId: process.env.${CURSEM_TERMINAL_ID_ENV} ?? null,
        pid: process.pid, // in-process: this IS the agent, for presence tracking
        payload: { event, sessionId, sessionFile, cwd: process.cwd() },
      }),
    }).catch(() => {});
  };
  for (const name of ["session_start", "agent_start", "agent_end", "session_shutdown"]) {
    pi.on(name as any, async (_event: unknown, ctx: any) => {
      post(name, ctx);
      return undefined;
    });
  }
}
`;

const piSpec = {
  projectFiles: [
    {
      relPath: `.pi/extensions/${CURSEM_HOOK_MARKER}.ts`,
      // CURSEM owns this whole file (the header marker says so): rewrite on
      // any drift — including a user edit — and leave every other file in
      // .pi/extensions/ alone. The content is boot-independent (the endpoint
      // rides in env), so an up-to-date file is never rewritten.
      build: (existing) => (existing === PI_EXTENSION_SOURCE ? null : PI_EXTENSION_SOURCE),
      // CURSEM owns this file outright (header marker). Remove it wholesale;
      // leave a user file that merely shares the name (no marker) alone.
      strip: (existing) => (existing.includes(CURSEM_HOOK_MARKER) ? { delete: true } : null),
    },
  ],
  normalize: (p) => {
    const base = {
      sessionId: str(p.sessionId),
      cwd: str(p.cwd) ?? undefined,
      transcriptPath: str(p.sessionFile) ?? undefined,
    };
    switch (p.event) {
      case 'session_start': return { kind: 'session-start', ...base };
      case 'agent_start': return { kind: 'turn-start', ...base };
      case 'agent_end': return { kind: 'turn-end', ...base };
      case 'session_shutdown': return { kind: 'session-end', ...base };
      default: return null;
    }
  },
};

// ---------------------------------------------------------------------------
// grok (xAI Grok Build) — hooks ride in <project>/.grok/hooks/cursem-hook.json.
// Grok loads every *.json in that dir, so CURSEM owns one file there outright
// rather than merging into a shared one (pi-style ownership, codex-style trust).
//
// Two grok-specific quirks (both pinned live by Cate's contract suite):
//
//  · Casing is split: the FILE keys events in CamelCase ("SessionStart"), the
//    PAYLOAD reports them in snake_case ("session_start") on a camelCase
//    envelope (sessionId / workspaceRoot / toolName). Neither spelling is a
//    typo; both are contract.
//  · Grok also scans OTHER vendors' hook files — <project>/.claude/settings
//    .json + settings.local.json — by default. CURSEM injects its claude
//    bridge into settings.local.json, so a grok session fires the CLAUDE
//    wrapper too, with a grok payload. The bridge drops those posts (see
//    BRIDGE_JS's GROK_HOOK_EVENT guard); without it a grok terminal would be
//    labelled Claude Code and offered claude's resume command.
//
// Project hooks are gated on grok's folder trust: until the user runs
// /hooks-trust, the file is silently inert (no error, no events) — and grok
// resolves a project root only inside a git repo, so a non-repo workspace
// never loads them at all. Both are normal, not failure states.
// ---------------------------------------------------------------------------

const GROK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'PostToolUse', 'Stop', 'SessionEnd'];

const GROK_HOOK_TIMEOUT = 60;

const grokSpec = {
  projectFiles: [
    {
      // `cursem-hook.json` is ours alone — grok merges every file in the dir,
      // so a user's own hooks live beside it untouched.
      relPath: `.grok/hooks/${CURSEM_HOOK_MARKER}.json`,
      build: (existing, ctx) =>
        mergeSharedHooksFile(existing, GROK_EVENTS, () => ({
          hooks: [{ type: 'command', command: ctx.bridgeCommand, timeout: GROK_HOOK_TIMEOUT }],
        })),
      strip: (existing) => (existing.includes(CURSEM_HOOK_MARKER) ? { delete: true } : null),
    },
  ],
  normalize: (p) => {
    const base = {
      sessionId: str(p.sessionId),
      cwd: str(p.cwd) ?? undefined,
      // Absent on session_start (the session file does not exist yet); the
      // updates.jsonl path from the first prompt onwards.
      transcriptPath: str(p.transcriptPath) ?? undefined,
    };
    switch (p.hookEventName) {
      case 'session_start': return { kind: 'session-start', ...base };
      case 'user_prompt_submit': return { kind: 'turn-start', ...base };
      // Fires after every executed tool call; the one following a
      // permission_prompt is the approval resolution.
      case 'post_tool_use': return { kind: 'turn-resume', ...base };
      case 'stop': return { kind: 'turn-end', ...base };
      case 'session_end': return { kind: 'session-end', ...base };
      case 'notification':
        // permission_prompt = parked on tool approval. PreToolUse fires ~30ms
        // earlier for the same call but precedes EVERY tool, approved or not,
        // so it cannot mark the wait — which is why it isn't injected at all.
        return p.notificationType === 'permission_prompt' ? { kind: 'permission-wait', ...base } : null;
      default: return null;
    }
  },
};

// ---------------------------------------------------------------------------
// opencode — an in-process plugin at <project>/.opencode/plugin/cursem-hook.js.
// opencode scans `{plugin,plugins}/*.{ts,js}` under every config directory it
// resolves and imports each match at startup. Two contract details Cate's
// suite pins: the extension must be .js (.mjs is outside the glob), and EVERY
// exported factory is invoked — not just the default — hence a single named
// export here.
//
// The plugin forwards only the five bus events CURSEM tracks; the bus is
// otherwise chatty (message parts, plugin.added, catalog.updated…).
// ---------------------------------------------------------------------------

const OPENCODE_PLUGIN_SOURCE = `// cursem-hook — generated by CURSEM IDE (agent hook injection); do not edit.
// Inert outside CURSEM terminals: it no-ops unless the CURSEM_HOOK_* env vars are set.
const ENDPOINT = process.env.${CURSEM_HOOK_ENDPOINT_ENV}
const TOKEN = process.env.${CURSEM_HOOK_TOKEN_ENV}
const TRACKED = new Set(["session.created", "session.status", "session.idle", "permission.asked", "permission.replied"])
export const CursemHookBridge = async () => {
  if (!ENDPOINT || !TOKEN) return {}
  return {
    event: async ({ event }) => {
      if (!event || !TRACKED.has(event.type)) return
      const props = event.properties ?? {}
      fetch(ENDPOINT + "/hook", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
        body: JSON.stringify({
          agentId: "opencode",
          terminalId: process.env.${CURSEM_TERMINAL_ID_ENV} ?? null,
          pid: process.pid, // in-process: this IS the agent, for presence tracking
          payload: {
            type: event.type,
            sessionID: props.sessionID ?? props.info?.id ?? null,
            status: props.status ?? null,
            directory: props.info?.directory ?? null,
            permission: props.permission ?? null,
            metadata: props.metadata ?? null,
          },
        }),
      }).catch(() => {})
    },
  }
}
`;

const opencodeSpec = {
  projectFiles: [
    {
      // `.js`, not `.mjs`: opencode's scan glob is `*.{ts,js}` only.
      relPath: `.opencode/plugin/${CURSEM_HOOK_MARKER}.js`,
      // CURSEM owns this whole file (the header marker says so): rewrite on
      // any drift and leave every other file in .opencode/plugin/ alone. The
      // content is boot-independent (the endpoint rides in env), so an
      // up-to-date file is never rewritten.
      build: (existing) => (existing === OPENCODE_PLUGIN_SOURCE ? null : OPENCODE_PLUGIN_SOURCE),
      strip: (existing) => (existing.includes(CURSEM_HOOK_MARKER) ? { delete: true } : null),
    },
  ],
  normalize: (p) => {
    const base = { sessionId: str(p.sessionID), cwd: str(p.directory) ?? undefined };
    switch (p.type) {
      case 'session.created': return { kind: 'session-start', ...base };
      case 'session.status':
        // busy marks the turn starting; the idle STATUS is redundant with the
        // explicit session.idle event below, so only busy maps.
        return p.status?.type === 'busy' ? { kind: 'turn-start', ...base } : null;
      case 'session.idle': return { kind: 'turn-end', ...base };
      case 'permission.asked': return { kind: 'permission-wait', ...base };
      // The user answered the permission prompt. Even a "reject" reply keeps
      // the turn in flight (the model receives the denial, produces text, and
      // idles), so every reply maps to turn-resume — the later turn-end
      // settles the state either way.
      case 'permission.replied': return { kind: 'turn-resume', ...base };
      default: return null;
    }
  },
};

// ---------------------------------------------------------------------------
// Registry + normalization entry point
// ---------------------------------------------------------------------------

export const AGENT_HOOK_SPECS = {
  'claude-code': claudeSpec,
  codex: codexSpec,
  cursor: cursorSpec,
  grok: grokSpec,
  pi: piSpec,
  opencode: opencodeSpec,
};

/** Normalize one raw bridge-posted payload into the shared event, or null when
 *  the agent is unknown or the payload isn't a tracked event. */
export function normalizeAgentHookPayload(agentId, terminalId, payload) {
  const spec = AGENT_HOOK_SPECS[agentId];
  if (!spec) return null;
  const fields = spec.normalize(payload);
  if (!fields) return null;
  return { terminalId, agentId, raw: payload, ...fields };
}
