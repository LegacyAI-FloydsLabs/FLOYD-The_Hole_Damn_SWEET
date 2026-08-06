#!/usr/bin/env node
// === cursem — CURSEM IDE in-shell control CLI ===============================
//
// Zero-dependency Node script (node:util + global fetch only). On PATH inside
// every CURSEM-spawned terminal (TerminalOne prepends cli/bin to PATH); any
// process in that shell — agent, script, human — can drive the IDE itself:
//
//   terminal  read / type / press      read & drive terminal sessions
//   editor    open                     open a workspace file, optionally :line:col
//   surface   list / focus / close / set-title
//   ui        notify
//   version                            host control API version
//
// Transport: one authenticated HTTP POST per invocation to $CURSEM_API/invoke
// with `Authorization: Bearer $CURSEM_TOKEN` → {result} | {error:{code,message}}.
//
// Exit codes: 0 ok · 1 remote failure · 2 usage · 3 environment/transport.
// --help is the honest, COMPLETE surface — there is no raw method passthrough.

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const CLI_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_READ_TAIL_LINES = 200;

export const EXIT = Object.freeze({ OK: 0, API: 1, USAGE: 2, ENV: 3 });

class UsageError extends Error {}
class ApiError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const USAGE = `cursem — control CURSEM IDE from its own terminals

usage: cursem <group> <verb> [args] [--panel <id>] [--json] [--timeout <ms>]

terminal
  read [--panel <id>] [--max <n>]   Rendered screen of a terminal (default: focused).
                                    Human output is capped to the last 200 lines;
                                    --max 0 lifts the cap, --max n sets it.
  type --panel <id> <text...>       Type text into a terminal. NO newline is
                                    appended — text executes only after press enter.
  press --panel <id> <key>          Press a key: enter tab esc backspace delete
                                    up down left right home end pageup pagedown
                                    ctrl-<letter>.

editor
  open <path[:line[:col]]>          Open a workspace file (trailing :line[:col]
                                    optional). Prints the editor surface id.

surface
  list                              One line per surface (* = focused).
  focus <id>                        Focus a surface (full id or unique prefix).
  close <id>                        Close a surface.
  set-title [--panel <id>] <title...>
                                    Retitle a terminal. With no --panel, retitles
                                    the caller's OWN terminal ($CURSEM_TERMINAL_ID).

ui
  notify <message...>               Post an in-app toast (+ desktop notification).

version                             Print the host control API version.
  --version                         Print this CLI's own version.

flags
  --panel <id>    Target surface/terminal (full id or unique 8-char prefix).
  --json          Print the raw result as one JSON line.
  --max <n>       Line cap for terminal read (0 = no cap).
  --timeout <ms>  Per-invocation timeout (default ${DEFAULT_TIMEOUT_MS}).
  --help          This text.

environment
  CURSEM_API            Injected by CURSEM IDE (loopback control endpoint).
  CURSEM_TOKEN          Injected bearer token.
  CURSEM_TERMINAL_ID    This terminal's own session id (self-addressing).

exit codes: 0 ok · 1 remote failure · 2 usage · 3 environment/transport`;

// ─── Verb registry ─────────────────────────────────────────────────────────
// Adding a verb is one entry. `build` returns {method, args} or throws
// UsageError; `format` renders the human output (--json bypasses it).

export const GROUPS = {
  terminal: {
    read: {
      usage: 'terminal read [--panel <id>] [--max <n>]',
      build: async (flags, _positionals, ctx) => ({
        method: 'cursem.terminal.read',
        args: { ...(flags.panel ? { targetId: await ctx.resolveSurface(flags.panel, 'terminal') } : {}) },
      }),
      format: (result, flags) => tailCap(String(result?.text ?? ''), parseMax(flags.max)),
    },
    type: {
      usage: 'terminal type --panel <id> <text...>',
      build: async (flags, positionals, ctx) => {
        if (!flags.panel) throw new UsageError('terminal type requires --panel <id> (a misresolved keystroke executes in the wrong shell).');
        if (positionals.length === 0) throw new UsageError('terminal type requires text to type.');
        return { method: 'cursem.terminal.type', args: { targetId: await ctx.resolveSurface(flags.panel, 'terminal'), text: positionals.join(' ') } };
      },
      format: () => 'ok',
    },
    press: {
      usage: 'terminal press --panel <id> <key>',
      build: async (flags, positionals, ctx) => {
        if (!flags.panel) throw new UsageError('terminal press requires --panel <id>.');
        const key = positionals[0];
        if (!key) throw new UsageError('terminal press requires a key name (enter, tab, esc, ctrl-<letter>, …).');
        return { method: 'cursem.terminal.press', args: { targetId: await ctx.resolveSurface(flags.panel, 'terminal'), key } };
      },
      format: () => 'ok',
    },
  },
  editor: {
    open: {
      usage: 'editor open <path[:line[:col]]>',
      build: async (_flags, positionals) => {
        const target = positionals[0];
        if (!target) throw new UsageError('editor open requires a path.');
        const { path, line, column } = parseFileTarget(target);
        return { method: 'cursem.editor.openFile', args: { path, ...(line ? { line, column: column ?? 1 } : {}) } };
      },
      format: (result) => shortId(result?.id),
    },
  },
  surface: {
    list: {
      usage: 'surface list',
      build: async () => ({ method: 'cursem.surface.list', args: {} }),
      format: (result) => {
        const surfaces = Array.isArray(result?.surfaces) ? result.surfaces : [];
        if (surfaces.length === 0) return '(no surfaces)';
        return surfaces.map((surface) => `${surface.focused ? '*' : ' '} ${shortId(surface.id)} ${surface.type} ${surface.title}`).join('\n');
      },
    },
    focus: {
      usage: 'surface focus <id>',
      build: async (_flags, positionals, ctx) => {
        const id = positionals[0];
        if (!id) throw new UsageError('surface focus requires an id.');
        return { method: 'cursem.surface.focus', args: { targetId: await ctx.resolveSurface(id) } };
      },
      format: () => 'ok',
    },
    close: {
      usage: 'surface close <id>',
      build: async (_flags, positionals, ctx) => {
        const id = positionals[0];
        if (!id) throw new UsageError('surface close requires an id.');
        return { method: 'cursem.surface.close', args: { targetId: await ctx.resolveSurface(id) } };
      },
      format: () => 'ok',
    },
    'set-title': {
      usage: 'surface set-title [--panel <id>] <title...>',
      build: async (flags, positionals, ctx) => {
        if (positionals.length === 0) throw new UsageError('surface set-title requires a title.');
        const targetId = flags.panel
          ? await ctx.resolveSurface(flags.panel, 'terminal')
          : ctx.selfTerminalId();
        if (!targetId) throw new UsageError('surface set-title without --panel only works inside a CURSEM terminal ($CURSEM_TERMINAL_ID is not set).');
        return { method: 'cursem.surface.setTitle', args: { targetId, title: positionals.join(' ') } };
      },
      format: () => 'ok',
    },
  },
  ui: {
    notify: {
      usage: 'ui notify <message...>',
      build: async (_flags, positionals) => {
        if (positionals.length === 0) throw new UsageError('ui notify requires a message.');
        return { method: 'cursem.ui.notify', args: { message: positionals.join(' ') } };
      },
      format: () => 'ok',
    },
  },
  version: {
    '': {
      usage: 'version',
      build: async () => ({ method: 'cursem.version', args: {} }),
      format: (result) => String(result?.version ?? 'unknown'),
    },
  },
};

// ─── Parsing helpers ────────────────────────────────────────────────────────

/** Split path:line:col — only TRAILING :digits[:digits] are stripped so
 *  Windows drive letters and colon-bearing names survive. */
export function parseFileTarget(raw) {
  const match = String(raw).match(/^(.*?)(?::(\d+)(?::(\d+))?)?$/);
  const path = match?.[1] ?? String(raw);
  const line = match?.[2] ? Number(match[2]) : undefined;
  const column = match?.[3] ? Number(match[3]) : undefined;
  return { path, line, column };
}

function parseMax(value) {
  if (value === undefined) return DEFAULT_READ_TAIL_LINES;
  const max = Number(value);
  if (!Number.isInteger(max) || max < 0) throw new UsageError('--max must be a non-negative integer (0 lifts the cap).');
  return max;
}

function tailCap(text, max) {
  if (max === 0) return text;
  const lines = text.split('\n');
  return lines.length <= max ? text : lines.slice(-max).join('\n');
}

function shortId(id) {
  return typeof id === 'string' ? id.slice(0, 8) : String(id ?? '');
}

export function parseCli(argv) {
  const options = {
    panel: { type: 'string' },
    max: { type: 'string' },
    timeout: { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'v', default: false },
  };
  try {
    return shapeParseResult(parseArgs({ args: argv, allowPositionals: true, strict: true, options }));
  } catch (error) {
    // Freeform-text verbs (`type`, `notify`, `set-title`) legitimately carry
    // dash-prefixed text like `ls -la`; strict mode rejects it as an unknown
    // short option (and reports only '-l', so the token can't be located from
    // the error text). Recover by re-scanning for the first unknown dash
    // token and treating it and everything after it as positionals. Unknown
    // LONG options stay hard usage errors.
    const message = error instanceof Error ? error.message : 'Could not parse arguments.';
    const index = firstUnknownDashToken(argv);
    if (index < 0 || argv[index].startsWith('--')) throw new UsageError(message);
    const head = parseArgs({ args: argv.slice(0, index), allowPositionals: true, strict: true, options });
    head.positionals.push(...argv.slice(index));
    return shapeParseResult(head);
  }
}

const VALUE_FLAGS = new Set(['--panel', '--max', '--timeout']);
const BOOLEAN_FLAGS = new Set(['--json', '--help', '-h', '--version', '-v']);

/** Index of the first token parseArgs strict mode would reject, or -1. */
function firstUnknownDashToken(argv) {
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--') return -1; // explicit separator: the rest is positional
    if (VALUE_FLAGS.has(token)) { index += 1; continue; }
    if (BOOLEAN_FLAGS.has(token)) continue;
    if (token.startsWith('--') && token.includes('=') && VALUE_FLAGS.has(token.slice(0, token.indexOf('=')))) continue;
    if (token.startsWith('-')) return index;
  }
  return -1;
}

function shapeParseResult(parsed) {
  const [group, verb, ...rest] = parsed.positionals;
  return { flags: parsed.values, group, verb, positionals: rest };
}

// ─── Transport ──────────────────────────────────────────────────────────────

async function send(io, method, args, timeoutMs) {
  const api = io.env.CURSEM_API;
  const token = io.env.CURSEM_TOKEN;
  const signal = io.timeoutSignal ? io.timeoutSignal(timeoutMs) : AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await (io.fetchImpl ?? fetch)(`${api}/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ method, args }),
      signal,
    });
  } catch (error) {
    throw new ApiError('transport', `Could not reach CURSEM IDE at ${api}: ${error instanceof Error ? error.message : 'request failed'}`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(body?.error?.code || `http-${response.status}`, body?.error?.message || `Control endpoint returned HTTP ${response.status}.`);
  }
  if (body?.error) {
    throw new ApiError(body.error.code || 'remote-error', body.error.message || body.error.code || 'The IDE rejected the call.');
  }
  return body?.result ?? null;
}

// ─── Entry ──────────────────────────────────────────────────────────────────

/**
 * Run the CLI. Dependency-injected for tests; returns the exit code.
 * io: { env, fetchImpl?, stdout(line), stderr(line), timeoutSignal?(ms) }
 */
export async function runCli(argv, io) {
  const out = io.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const err = io.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  try {
    const { flags, group, verb, positionals } = parseCli(argv);
    if (flags.help) { out(USAGE); return EXIT.OK; }
    if (flags.version) { out(String(CLI_VERSION)); return EXIT.OK; }
    if (!group) { err(USAGE); return EXIT.USAGE; }

    const groupDef = GROUPS[group];
    if (!groupDef) throw new UsageError(`Unknown group "${group}". Run cursem --help.`);
    const verbDef = groupDef[verb ?? ''] ?? (verb === undefined ? groupDef[''] : undefined);
    if (!verbDef) throw new UsageError(`Unknown verb "${group} ${verb ?? ''}". Run cursem --help.`);

    if (!io.env.CURSEM_API || !io.env.CURSEM_TOKEN) {
      err('cursem: CURSEM_API/CURSEM_TOKEN are not set in this shell.');
      err('The cursem CLI is wired into terminals spawned by CURSEM IDE. In any');
      err('other shell there is nothing to talk to. Inside a CURSEM terminal this');
      err('means the control surface is off — enable "In-shell CLI (cursem)" in');
      err('Settings → CLI, then open a fresh terminal.');
      return EXIT.ENV;
    }

    const timeoutMs = flags.timeout !== undefined ? Number(flags.timeout) : DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new UsageError('--timeout must be a positive number of milliseconds.');

    const invoke = (method, args) => send(io, method, args, timeoutMs);
    const ctx = {
      selfTerminalId: () => io.env.CURSEM_TERMINAL_ID || null,
      resolveSurface: async (prefix, type) => {
        const result = await invoke('cursem.surface.list', {});
        const surfaces = (Array.isArray(result?.surfaces) ? result.surfaces : [])
          .filter((surface) => !type || surface.type === type);
        const exact = surfaces.find((surface) => surface.id === prefix);
        if (exact) return exact.id;
        const matches = surfaces.filter((surface) => typeof surface.id === 'string' && surface.id.startsWith(prefix));
        if (matches.length === 0) throw new UsageError(`no-such: no ${type ?? ''} surface matches "${prefix}".`);
        if (matches.length > 1) throw new UsageError(`ambiguous: "${prefix}" matches ${matches.length} surfaces (${matches.map((surface) => shortId(surface.id)).join(', ')}).`);
        return matches[0].id;
      },
    };

    const request = await verbDef.build(flags, positionals, ctx);
    const result = await invoke(request.method, request.args);
    if (flags.json) out(JSON.stringify(result));
    else out(verbDef.format(result, flags) ?? 'ok');
    return EXIT.OK;
  } catch (error) {
    if (error instanceof UsageError) {
      err(`cursem: ${error.message}`);
      return EXIT.USAGE;
    }
    if (error instanceof ApiError) {
      err(`cursem: ${error.code}: ${error.message}`);
      return error.code === 'transport' ? EXIT.ENV : EXIT.API;
    }
    err(`cursem: ${error instanceof Error ? error.message : 'unexpected failure'}`);
    return EXIT.API;
  }
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  const code = await runCli(process.argv.slice(2), { env: process.env });
  process.exit(code);
}
