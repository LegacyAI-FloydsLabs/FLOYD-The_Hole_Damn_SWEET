#!/usr/bin/env node
/**
 * FLOYD Frame server — the single-surface shell host.
 * - Serves the frame UI (spring-loaded drawer + background stage).
 * - Owns interchangeable app processes declared in registry.json (nothing built in).
 * - Spawns dedicated TerminalOne instances whose shell IS the CLI app (ff / floydcode),
 *   so terminal apps present already open.
 * - Backgrounds: PNG served as-is, TIFF auto-converted once via macOS sips.
 * - Solo use: binds 127.0.0.1 by default; remote access requires a separate private overlay.
 */
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { chmodSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import net from "node:net";

const ROOT = dirname(fileURLToPath(import.meta.url));
const FRAME_DIR = resolve(ROOT, "..");
const PUBLIC_DIR = join(FRAME_DIR, "public");
const BACKGROUNDS_DIR = join(FRAME_DIR, "backgrounds");
const REGISTRY_PATH = join(FRAME_DIR, "registry.json");
const HOST = process.env.FRAME_HOST || "127.0.0.1";
const PORT = Number(process.env.FRAME_PORT || 13030);

// ---- managed process table -------------------------------------------------
// Every app the frame can own. Terminal apps get their own TerminalOne server
// whose SHELL is a wrapper that execs the CLI, so the frame shows it pre-open.
// All apps run from monorepo copies under intake/surfaces/ — originals
// elsewhere on disk are never touched by the frame.
const SURFACES = "/Volumes/Storage/FLOYD_WORKSTATION/intake/surfaces";
const PTY_COPY = join(SURFACES, "pty");
// One node for everything: homebrew node (native modules in the copies are
// built against it). No per-service pins.
// Prefer Homebrew node; fall back to the node running this server so the
// frame works on a fresh OS before Homebrew is installed (new-world boot).
const NODE_BIN = existsSync("/opt/homebrew/bin/node") ? "/opt/homebrew/bin/node" : process.execPath;
const WRAPPER_DIR = join(FRAME_DIR, "server", "shells");
mkdirSync(WRAPPER_DIR, { recursive: true });
mkdirSync(BACKGROUNDS_DIR, { recursive: true });

function wrapperFor(id, execLine) {
  const path = join(WRAPPER_DIR, `${id}.sh`);
  writeFileSync(path, `#!/bin/zsh\n# frame-managed shell for ${id} — TerminalOne spawns this as SHELL\nexec ${execLine}\n`, { mode: 0o755 });
  return path;
}

// ---- provider key vault ------------------------------------------------------
// One place for vendor API keys. Stored 0600 in FLOYD_RUNTIME/secrets, injected
// into every managed app's environment at launch, never returned unmasked.
const SECRETS_DIR = "/Volumes/Storage/FLOYD_RUNTIME/secrets";
const VAULT_PATH = join(SECRETS_DIR, "provider-keys.json");
const PROVIDERS = [
  { id: "openai",     name: "OpenAI",       env: "OPENAI_API_KEY",       prefixes: ["sk-proj-", "sk-svcacct-"], ambiguous: ["sk-"], url: "https://platform.openai.com/api-keys",
    test: (k) => ({ url: "https://api.openai.com/v1/models", headers: { authorization: `Bearer ${k}` } }) },
  { id: "anthropic",  name: "Anthropic",    env: "ANTHROPIC_API_KEY",    prefixes: ["sk-ant-"], url: "https://console.anthropic.com/settings/keys",
    test: (k) => ({ url: "https://api.anthropic.com/v1/models", headers: { "x-api-key": k, "anthropic-version": "2023-06-01" } }) },
  { id: "google",     name: "Google Gemini", env: "GEMINI_API_KEY",      prefixes: ["AIza"], url: "https://aistudio.google.com/apikey",
    test: (k) => ({ url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(k)}` }) },
  { id: "openrouter", name: "OpenRouter",   env: "OPENROUTER_API_KEY",   prefixes: ["sk-or-"], url: "https://openrouter.ai/settings/keys",
    test: (k) => ({ url: "https://openrouter.ai/api/v1/models", headers: { authorization: `Bearer ${k}` } }) },
  { id: "xai",        name: "xAI Grok",     env: "XAI_API_KEY",          prefixes: ["xai-"], url: "https://console.x.ai",
    test: (k) => ({ url: "https://api.x.ai/v1/models", headers: { authorization: `Bearer ${k}` } }) },
  { id: "deepseek",   name: "DeepSeek",     env: "DEEPSEEK_API_KEY",     prefixes: [], ambiguous: ["sk-"], url: "https://platform.deepseek.com/api_keys",
    test: (k) => ({ url: "https://api.deepseek.com/models", headers: { authorization: `Bearer ${k}` } }) },
  { id: "groq",       name: "Groq",         env: "GROQ_API_KEY",         prefixes: ["gsk_"], url: "https://console.groq.com/keys",
    test: (k) => ({ url: "https://api.groq.com/openai/v1/models", headers: { authorization: `Bearer ${k}` } }) },
  { id: "mistral",    name: "Mistral",      env: "MISTRAL_API_KEY",      prefixes: [], ambiguous: ["sk-"], url: "https://console.mistral.ai/api-keys",
    test: (k) => ({ url: "https://api.mistral.ai/v1/models", headers: { authorization: `Bearer ${k}` } }) },
  { id: "huggingface", name: "Hugging Face", env: "HF_TOKEN",            prefixes: ["hf_"], url: "https://huggingface.co/settings/tokens",
    test: (k) => ({ url: "https://huggingface.co/api/whoami-v2", headers: { authorization: `Bearer ${k}` } }) },
  { id: "github",     name: "GitHub",       env: "GITHUB_TOKEN",         prefixes: ["ghp_", "github_pat_", "gho_"], url: "https://github.com/settings/tokens",
    test: (k) => ({ url: "https://api.github.com/user", headers: { authorization: `Bearer ${k}`, "user-agent": "floyd-frame" } }) },
  { id: "elevenlabs", name: "ElevenLabs",   env: "ELEVENLABS_API_KEY",   prefixes: [], url: "https://elevenlabs.io/app/settings/api-keys",
    test: (k) => ({ url: "https://api.elevenlabs.io/v1/user", headers: { "xi-api-key": k } }) },
  { id: "zai",        name: "Z.ai GLM Coding", env: "GLM_API_KEY", envAliases: ["ZAI_API_KEY"], prefixes: [], url: "https://z.ai/manage-apikey/apikey-list",
    // GLM Coding Max plan: OpenAI-compatible coding endpoint is the ONLY valid surface.
    test: (k) => ({ url: "https://api.z.ai/api/coding/paas/v4/chat/completions", method: "POST",
      headers: { authorization: `Bearer ${k}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.7", max_tokens: 1, messages: [{ role: "user", content: "ok" }] }) }) },
  { id: "minimax",    name: "MiniMax Coding Plan", env: "MINIMAX_API_KEY", prefixes: ["sk-cp-"], url: "https://platform.minimax.io/user-center/payment/token-plan",
    // MiniMax Coding/Token Plan subscription key: Anthropic-compatible coding endpoint.
    test: (k) => ({ url: "https://api.minimax.io/anthropic/v1/messages", method: "POST",
      headers: { authorization: `Bearer ${k}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "MiniMax-M3", max_tokens: 1, messages: [{ role: "user", content: "ok" }] }) }) },
  { id: "moonshot",   name: "Kimi (Moonshot) API", env: "MOONSHOT_API_KEY", envAliases: ["KIMI_API_KEY"], prefixes: [], ambiguous: ["sk-"], url: "https://platform.moonshot.ai/console/api-keys",
    test: (k) => ({ url: "https://api.moonshot.ai/v1/models", headers: { authorization: `Bearer ${k}` } }) },
  { id: "tavily",     name: "Tavily Search", env: "TAVILY_API_KEY",      prefixes: ["tvly-"], url: "https://app.tavily.com" },
  { id: "fal",        name: "fal.ai",       env: "FAL_KEY",              prefixes: [], url: "https://fal.ai/dashboard/keys",
    test: (k) => ({ url: "https://fal.run/health", headers: { authorization: `Key ${k}` } }) },
];

function readVault() {
  try { return JSON.parse(readFileSync(VAULT_PATH, "utf8")); } catch { return {}; }
}
function writeVault(vault) {
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(VAULT_PATH, JSON.stringify(vault, null, 2), { mode: 0o600 });
  chmodSync(VAULT_PATH, 0o600);
}
/** Env block injected into every managed app: vault keys never override an
 * explicitly exported process env var (explicit always wins). */
function vaultEnv() {
  const vault = readVault();
  const env = {};
  for (const p of PROVIDERS) {
    const key = vault[p.id]?.key;
    if (!key) continue;
    for (const name of [p.env, ...(p.envAliases || [])]) {
      if (!process.env[name]) env[name] = key;
    }
  }
  return env;
}
const maskKey = (k) => (k.length <= 12 ? `${k.slice(0, 3)}…` : `${k.slice(0, 8)}…${k.slice(-4)}`);
/** Apps that read keys from their own .env.local files rather than the
 * environment (CURSEM, Floyd Desktop). Upsert KEY=value lines in place. */
function upsertEnvFile(path, updates) {
  let lines = [];
  try { lines = readFileSync(path, "utf8").split("\n"); } catch {}
  for (const [k, v] of Object.entries(updates)) {
    const line = `${k}=${v}`;
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = line; else lines.push(line);
  }
  writeFileSync(path, lines.filter((l, i) => l !== "" || i < lines.length - 1).join("\n"), { mode: 0o600 });
}
/** Some consumers read keys from their own config files, not the environment.
 * Propagate on save so ONE paste updates the whole stack. Best-effort: failures
 * are reported but never block the vault save. */
function propagateKey(providerId, key) {
  const notes = [];
  const provider = PROVIDERS.find((p) => p.id === providerId);
  const envNames = provider ? [provider.env, ...(provider.envAliases || [])] : [];
  // .env.local consumers (CURSEM IDE + Floyd Desktop read these at boot).
  const envFiles = [
    join(SURFACES, "ide", ".env.local"),
    join(SURFACES, "desktop", ".env.local"),
  ];
  for (const file of envFiles) {
    try {
      upsertEnvFile(file, Object.fromEntries(envNames.map((n) => [n, key])));
      notes.push(`${file.split("/surfaces/")[1]} updated`);
    } catch (err) {
      notes.push(`${file}: ${String(err?.message ?? err).slice(0, 60)}`);
    }
  }
  if (providerId === "zai") {
    // Floyd Core validates provider.zai-coding-plan.options.apiKey from the
    // user's opencode config at startup (fail-closed).
    const cfgPath = join(process.env.HOME, ".config/opencode/opencode.json");
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      cfg.provider ??= {};
      cfg.provider["zai-coding-plan"] ??= {};
      cfg.provider["zai-coding-plan"].options ??= {};
      cfg.provider["zai-coding-plan"].options.apiKey = key;
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      notes.push("opencode config updated — restart Floyd Core to pick it up");
    } catch (err) {
      notes.push(`opencode config not updated: ${String(err?.message ?? err).slice(0, 80)}`);
    }
  }
  return notes;
}
/** Vendor auto-detection from key shape. Returns {match} on a unique prefix hit,
 * {candidates} when the shape fits several vendors (e.g. bare "sk-"). */
function detectProvider(key) {
  const exact = PROVIDERS.filter((p) => p.prefixes.some((x) => key.startsWith(x)));
  if (exact.length === 1) return { match: exact[0] };
  const loose = PROVIDERS.filter((p) => (p.ambiguous || []).some((x) => key.startsWith(x)));
  if (exact.length === 0 && loose.length === 1) return { match: loose[0] };
  const candidates = [...new Set([...exact, ...loose])];
  return { candidates: candidates.length ? candidates : PROVIDERS };
}
async function testProviderKey(provider, key, endpointOverride) {
  if (!provider.test) return { tested: false, note: "no live test for this vendor" };
  const spec = provider.test(key);
  // A custom endpoint replaces the URL's origin+path root while keeping the
  // vendor-specific auth headers and request shape.
  const url = endpointOverride ? spec.url.replace(defaultEndpoint(provider), endpointOverride) : spec.url;
  try {
    const res = await fetch(url, {
      method: spec.method || "GET",
      headers: spec.headers || {},
      body: spec.body,
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return { tested: true, valid: true, endpoint: url };
    return { tested: true, valid: false, status: res.status, endpoint: url, note: res.status === 401 || res.status === 403 ? "rejected by vendor (bad or expired key)" : `vendor answered HTTP ${res.status}` };
  } catch (err) {
    return { tested: false, endpoint: url, note: `could not reach vendor: ${String(err?.message ?? err).slice(0, 120)}` };
  }
}
/** The endpoint root a provider talks to (origin + base path, no method-specific
 * suffix). Derived from the test URL so display and override share one truth. */
function defaultEndpoint(provider) {
  if (!provider.test) return null;
  const u = new URL(provider.test("x").url);
  // strip the terminal resource segment (/models, /chat/completions, /user, …)
  return `${u.origin}${u.pathname.replace(/\/(models|chat\/completions|messages|user|whoami-v2|health)$/, "")}`;
}

const MANAGED = {
  "cursem-ide": {
    port: 13012,
    cwd: join(SURFACES, "ide"),
    cmd: NODE_BIN, args: ["server/cursem-server.mjs"],
    env: {
      CURSEM_PORT: "13012",
      // Allow embedding ONLY by local frame origins. Remote access is disabled
      // until a private overlay is configured.
      CURSEM_FRAME_ANCESTORS: "http://127.0.0.1:13030 http://localhost:13030 http://floyd.localhost:13030",
    },
  },
  "floyd-desktop": {
    port: 13010,
    cwd: join(SURFACES, "desktop"),
    cmd: NODE_BIN, args: ["dist-server/index.js"],
    env: { PORT: "13010" },
  },
  "harness-launcher": {
    port: 13014,
    cwd: join(SURFACES, "launcher"),
    cmd: NODE_BIN, args: ["src/server.js"],
    env: { PORT: "13014", HOST: "127.0.0.1" },
  },
  "floyd-code-cli": {
    port: 13022,
    cwd: PTY_COPY,
    cmd: NODE_BIN, args: ["src/server.js"],
    // Runs the monorepo runtime copy (intake/surfaces/ff) — the launcher
    // refreshes bin/ from the canonical install read-only, then execs it.
    env: () => ({ PORT: "13022", SHELL: wrapperFor("floyd-code-cli", join(SURFACES, "ff", "launch.sh")) }),
  },
  "ohmyfloyd": {
    port: 13023,
    cwd: PTY_COPY,
    cmd: NODE_BIN, args: ["src/server.js"],
    // Runs the monorepo runtime copy (intake/surfaces/omf). The launcher first
    // lets the canonical OhMyFloyd self-heal its Floyd branding (guard in its
    // customizations/), refreshes bin/ from it read-only, then execs the copy.
    env: () => ({ PORT: "13023", SHELL: wrapperFor("ohmyfloyd", join(SURFACES, "omf", "launch.sh")) }),
  },
  "terminalone": {
    port: 13013,
    cwd: PTY_COPY,
    cmd: NODE_BIN, args: ["src/server.js"],
    // Plain shell — no SHELL override, TerminalOne falls back to zsh.
    env: { PORT: "13013", TERMINALONE_ALLOWED_ORIGIN: "http://127.0.0.1:13013" },
  },
};

// Browork is a page inside Floyd Desktop — launching it ensures the same
// server (ensureApp is idempotent: it checks the port before spawning).
MANAGED["browork"] = MANAGED["floyd-desktop"];

const children = new Map(); // id -> ChildProcess

function portOpen(port) {
  return new Promise((done) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const finish = (up) => { sock.destroy(); done(up); };
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    sock.setTimeout(900, () => finish(false));
  });
}

async function ensureApp(id) {
  const spec = MANAGED[id];
  if (!spec) return { id, managed: false };
  if (await portOpen(spec.port)) return { id, managed: true, up: true, port: spec.port };
  if (!existsSync(spec.cwd)) return { id, managed: true, up: false, error: `missing cwd ${spec.cwd}` };
  const env = { ...process.env, ...vaultEnv(), ...(typeof spec.env === "function" ? spec.env() : spec.env) };
  const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: false });
  children.set(id, child);
  child.stdout.on("data", (d) => process.stdout.write(`[${id}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${id}] ${d}`));
  child.on("exit", (code) => { children.delete(id); console.log(`[frame] ${id} exited code=${code}`); });
  for (let i = 0; i < 40; i++) {
    if (await portOpen(spec.port)) return { id, managed: true, up: true, port: spec.port, started: true };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { id, managed: true, up: false, error: "did not open its port within 10s" };
}

// Internal browser: these extensions are PERMANENT. Every launch loads them;
// a launch that cannot load both is an error, not a degraded browser.
// Version-controlled copies live with the frame that loads them (no symlinks;
// refresh from the originals via scripts/refresh-extension-copies.sh).
const EXTENSIONS_DIR = join(FRAME_DIR, "extensions");
const INTERNAL_EXTENSIONS = [
  join(EXTENSIONS_DIR, "open-anvil"),
  join(EXTENSIONS_DIR, "floyd-tty-bridge"),
];
// Dedicated profile so the internal browser's state persists independent of
// the human's Chrome, plus a fixed CDP port so the frame (and every agent via
// the MCP gateway) can drive it.
const INTERNAL_BROWSER_PROFILE = "/Volumes/Storage/FLOYD_RUNTIME/internal-browser-profile";
const INTERNAL_BROWSER_CDP_PORT = 9223;
const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function cdpHttp(pathName, method = "GET") {
  return new Promise((done, fail) => {
    const req = http.request({ host: "127.0.0.1", port: INTERNAL_BROWSER_CDP_PORT, path: pathName, method, timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => { try { done(JSON.parse(body)); } catch (e) { fail(e); } });
    });
    req.on("error", fail);
    req.on("timeout", () => req.destroy(new Error("CDP timeout")));
    req.end();
  });
}

/** Load both permanent extensions over CDP. Branded Chrome ships with
 * --load-extension DISABLED (silently ignored since Chrome 137), so flag
 * loading is a lie; Extensions.loadUnpacked is the only path that works.
 * Idempotent: reloading an already-loaded path returns the same id. */
async function loadInternalExtensions() {
  const version = await cdpHttp("/json/version");
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((done, fail) => { ws.onopen = done; ws.onerror = () => fail(new Error("CDP websocket failed")); });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  const send = (method, params) => new Promise((done) => {
    const id = ++msgId;
    pending.set(id, done);
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    const loaded = [];
    for (const path of INTERNAL_EXTENSIONS) {
      const res = await send("Extensions.loadUnpacked", { path });
      if (!res.result?.id) throw new Error(`extension failed to load: ${path}: ${JSON.stringify(res.error ?? res)}`);
      loaded.push({ path, id: res.result.id });
    }
    return loaded;
  } finally {
    ws.close();
  }
}

async function openChrome(url) {
  const missing = INTERNAL_EXTENSIONS.filter((p) => !existsSync(join(p, "manifest.json")));
  if (missing.length) throw new Error(`internal browser extensions missing: ${missing.join(", ")}`);
  mkdirSync(INTERNAL_BROWSER_PROFILE, { recursive: true });

  // Reuse a live internal browser if its CDP port answers; otherwise launch.
  let alive = false;
  try { await cdpHttp("/json/version"); alive = true; } catch {}
  if (!alive) {
    const child = spawn(CHROME_BIN, [
      `--user-data-dir=${INTERNAL_BROWSER_PROFILE}`,
      `--remote-debugging-port=${INTERNAL_BROWSER_CDP_PORT}`,
      "--enable-unsafe-extension-debugging",
      "--no-first-run", "--no-default-browser-check",
      ...(url ? [url] : []),
    ], { detached: true, stdio: "ignore" });
    child.unref();
    let up = false;
    for (let i = 0; i < 40; i++) {
      try { await cdpHttp("/json/version"); up = true; break; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!up) throw new Error("internal browser did not expose its CDP port within 10s");
  } else if (url) {
    await cdpHttp(`/json/new?${encodeURIComponent(url)}`, "PUT").catch(() => {});
  }

  // Extensions are mandatory: verify the actual load, not the launch.
  const loaded = await loadInternalExtensions();
  if (alive) {
    // Surface the reused window for the human.
    execFile("open", ["-a", "Google Chrome"], () => {});
  }
  return { cdpPort: INTERNAL_BROWSER_CDP_PORT, loaded };
}

// ---- chrono sandbox bridge -------------------------------------------------
// Exposes the Python time-manipulation controller (ops/chrono/chrono_sandbox.py)
// per surface. Only surfaces that are git repos are eligible. The UI drives
// this through /api/chrono/<surface>/<op>.
const CHRONO_PY = "/opt/homebrew/bin/python3";
const CHRONO_CLI = "/Volumes/Storage/FLOYD_WORKSTATION/ops/chrono/chrono_sandbox.py";
const CHRONO_SURFACES = {
  ide: join(SURFACES, "ide"),
  desktop: join(SURFACES, "desktop"),
  launcher: join(SURFACES, "launcher"),
  pty: PTY_COPY,
  workstation: "/Volumes/Storage/FLOYD_WORKSTATION",
};
// op -> argv builder. Validation is strict: no free-form strings reach the CLI.
const CHRONO_OPS = {
  snapshot: (q) => ["snapshot", ...(q.message ? ["-m", q.message] : [])],
  rewind: (q) => ["rewind", ...(q.to ? ["--to", q.to] : []), ...(q.hard === "1" ? ["--hard"] : [])],
  fork: (q) => {
    const names = String(q.names || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!names.length || names.some((n) => !/^[\w-]{1,40}$/.test(n))) return null;
    return ["fork", ...names];
  },
  forks: () => ["forks"],
  diff: (q) => (/^[\w-]{1,40}$/.test(q.name || "") ? ["diff", q.name] : null),
  "merge-winner": (q) => (/^[\w-]{1,40}$/.test(q.name || "") ? ["merge-winner", q.name] : null),
  prune: (q) => (q.all === "1" ? ["prune", "--all"] : (/^[\w-]{1,40}$/.test(q.name || "") ? ["prune", q.name] : null)),
  ledger: (q) => ["ledger", "-n", String(Math.min(Number(q.n) || 20, 100))],
  log: () => null, // handled inline below (read-only git log)
};
function chronoRun(repo, argv) {
  return new Promise((done) => {
    execFile(CHRONO_PY, [CHRONO_CLI, repo, ...argv], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (stdout) { try { return done(JSON.parse(stdout)); } catch {} }
      done({ ok: false, error: (stderr || String(err) || "chrono failed").slice(0, 500) });
    });
  });
}
function chronoLog(repo, n) {
  // Rewind targets are shadow snapshots (refs/chrono/snapshots), not branch
  // commits — the CLI's timeline op reads that ref.
  return chronoRun(repo, ["timeline", "-n", String(n)]);
}

// ---- http ------------------------------------------------------------------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".tiff": "image/tiff", ".tif": "image/tiff" };
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

function listBackgrounds() {
  return readdirSync(BACKGROUNDS_DIR)
    .filter((f) => /\.(png|jpe?g|webp|tiff?)$/i.test(f) && !f.startsWith("."))
    .sort();
}

/** TIFFs do not render in Chromium; convert once with sips and serve the PNG twin. */
function servableBackground(file) {
  if (!/\.tiff?$/i.test(file)) return join(BACKGROUNDS_DIR, file);
  const png = join(BACKGROUNDS_DIR, file.replace(/\.tiff?$/i, ".converted.png"));
  if (!existsSync(png)) {
    try {
      const r = spawn("sips", ["-s", "format", "png", join(BACKGROUNDS_DIR, file), "--out", png], { stdio: "ignore" });
      return new Promise((done) => r.on("exit", () => done(existsSync(png) ? png : join(BACKGROUNDS_DIR, file))));
    } catch { return join(BACKGROUNDS_DIR, file); }
  }
  return png;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  try {
    if (path === "/api/registry") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(readFileSync(REGISTRY_PATH));
    }
    if (path === "/api/status") {
      const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
      const out = {};
      for (const app of registry.apps) {
        const spec = MANAGED[app.id];
        out[app.id] = spec ? { managed: true, up: await portOpen(spec.port), port: spec.port } : { managed: false, up: null };
      }
      return json(res, 200, { apps: out, backgrounds: listBackgrounds() });
    }
    if (path === "/api/heartbeat" && req.method === "POST") {
      let body = ""; for await (const c of req) body += c;
      let apps = [];
      try { apps = JSON.parse(body).apps ?? []; } catch {}
      writeFileSync(join(ROOT, "heartbeat.json"), JSON.stringify({ ts: Date.now(), apps }));
      return json(res, 200, { ok: true });
    }
    if (path.startsWith("/api/launch/") && req.method === "POST") {
      const id = decodeURIComponent(path.slice("/api/launch/".length));
      return json(res, 200, await ensureApp(id));
    }
    if (path.startsWith("/api/quit/") && req.method === "POST") {
      const id = decodeURIComponent(path.slice("/api/quit/".length));
      const spec = MANAGED[id];
      if (!spec) return json(res, 404, { id, error: "not a managed app" });
      // Prefer our child handle; fall back to whoever owns the port (e.g. a
      // server that survived a frame restart).
      const child = children.get(id);
      if (child) { try { child.kill("SIGTERM"); } catch {} children.delete(id); }
      else {
        await new Promise((done) => {
          execFile("lsof", ["-nP", "-ti", `tcp:${spec.port}`, "-sTCP:LISTEN"], (err, stdout) => {
            const pid = Number((stdout || "").trim().split("\n")[0]);
            if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} }
            done();
          });
        });
      }
      // Confirm the port actually closed (graceful shutdown can take a moment).
      for (let i = 0; i < 20; i++) {
        if (!(await portOpen(spec.port))) return json(res, 200, { id, quit: true });
        await new Promise((r) => setTimeout(r, 250));
      }
      return json(res, 200, { id, quit: false, error: "port still open after SIGTERM" });
    }
    // chrono sandbox: GET /api/chrono/surfaces | POST /api/chrono/<surface>/<op>?...
    if (path === "/api/chrono/surfaces" && req.method === "GET") {
      const out = {};
      for (const [name, repo] of Object.entries(CHRONO_SURFACES)) out[name] = { repo, git: existsSync(join(repo, ".git")) };
      return json(res, 200, { ok: true, surfaces: out });
    }
    if (path.startsWith("/api/chrono/")) {
      const [surface, op] = path.slice("/api/chrono/".length).split("/");
      const repo = CHRONO_SURFACES[surface];
      if (!repo) return json(res, 404, { ok: false, error: `unknown surface ${surface}` });
      if (!existsSync(join(repo, ".git"))) return json(res, 400, { ok: false, error: `${surface} is not a git repo` });
      const q = Object.fromEntries(url.searchParams);
      const readOnly = ["forks", "diff", "ledger", "log"].includes(op);
      if (!readOnly && req.method !== "POST") return json(res, 405, { ok: false, error: "mutating chrono ops require POST" });
      if (op === "log") return json(res, 200, await chronoLog(repo, Math.min(Number(q.n) || 15, 60)));
      const build = CHRONO_OPS[op];
      if (!build) return json(res, 404, { ok: false, error: `unknown op ${op}` });
      const argv = build(q);
      if (!argv) return json(res, 400, { ok: false, error: `invalid arguments for ${op}` });
      return json(res, 200, await chronoRun(repo, argv));
    }
    // ---- provider key vault API ----
    // GET  /api/keys                 -> providers + masked stored keys (never raw)
    // POST /api/keys/detect          -> {key} -> vendor auto-detect from shape
    // POST /api/keys/:provider       -> {key} -> live-test then save
    // DELETE /api/keys/:provider     -> remove
    if (path === "/api/keys" && req.method === "GET") {
      const vault = readVault();
      // ChatGPT subscription (OAuth) — credential REFERENCE only. The durable
      // token store is ~/.codex/auth.json (Codex-owned, auto-refreshed). Raw
      // tokens are never copied into the vault or returned by this API.
      let chatgptSubscription = { configured: false, authFile: join(homedir(), ".codex", "auth.json"), accountId: null };
      try {
        const auth = JSON.parse(readFileSync(chatgptSubscription.authFile, "utf8"));
        if (auth?.tokens?.access_token && auth?.tokens?.refresh_token) {
          chatgptSubscription = {
            configured: true,
            authFile: chatgptSubscription.authFile,
            accountId: auth.tokens.account_id ? `${String(auth.tokens.account_id).slice(0, 8)}…` : null,
          };
        }
      } catch { /* not signed in */ }
      return json(res, 200, {
        chatgptSubscription,
        providers: PROVIDERS.map((p) => ({
          id: p.id, name: p.name, env: p.env, envAliases: p.envAliases || [], url: p.url, testable: Boolean(p.test),
          endpoint: vault[p.id]?.endpoint || defaultEndpoint(p),
          defaultEndpoint: defaultEndpoint(p),
          customEndpoint: Boolean(vault[p.id]?.endpoint),
          configured: Boolean(vault[p.id]?.key),
          masked: vault[p.id]?.key ? maskKey(vault[p.id].key) : null,
          verified: vault[p.id]?.verified ?? null,
          savedAt: vault[p.id]?.savedAt ?? null,
        })),
      });
    }
    if (path === "/api/keys/detect" && req.method === "POST") {
      let body = ""; for await (const c of req) body += c;
      const key = (JSON.parse(body || "{}").key || "").trim();
      if (!key) return json(res, 400, { error: "empty key" });
      const d = detectProvider(key);
      return json(res, 200, d.match
        ? { match: { id: d.match.id, name: d.match.name } }
        : { candidates: d.candidates.map((p) => ({ id: p.id, name: p.name })) });
    }
    // PUT /api/keys/:provider/endpoint -> {endpoint} -> set/reset custom endpoint (re-tests stored key)
    if (path.startsWith("/api/keys/") && path.endsWith("/endpoint") && req.method === "PUT") {
      const id = decodeURIComponent(path.slice("/api/keys/".length, -"/endpoint".length));
      const provider = PROVIDERS.find((p) => p.id === id);
      if (!provider) return json(res, 404, { error: `unknown provider ${id}` });
      let body = ""; for await (const c of req) body += c;
      let endpoint = (JSON.parse(body || "{}").endpoint || "").trim().replace(/\/+$/, "");
      if (endpoint && !/^https?:\/\/[\w.-]+(:\d+)?(\/[\w./-]*)?$/.test(endpoint)) return json(res, 400, { error: "endpoint must be a plain http(s) URL" });
      if (endpoint === defaultEndpoint(provider)) endpoint = ""; // resetting to default clears the override
      const vault = readVault();
      const entry = vault[id] || {};
      if (endpoint) entry.endpoint = endpoint; else delete entry.endpoint;
      let check = null;
      if (entry.key) {
        check = await testProviderKey(provider, entry.key, endpoint || undefined);
        entry.verified = check.tested ? check.valid === true : null;
      }
      vault[id] = entry;
      writeVault(vault);
      return json(res, 200, { provider: id, endpoint: endpoint || defaultEndpoint(provider), custom: Boolean(endpoint), check });
    }
    if (path.startsWith("/api/keys/") && req.method === "POST") {
      const id = decodeURIComponent(path.slice("/api/keys/".length));
      const provider = PROVIDERS.find((p) => p.id === id);
      if (!provider) return json(res, 404, { error: `unknown provider ${id}` });
      let body = ""; for await (const c of req) body += c;
      const key = (JSON.parse(body || "{}").key || "").trim();
      if (!key || key.length < 8 || /\s/.test(key)) return json(res, 400, { error: "that does not look like an API key" });
      const vault = readVault();
      const endpointOverride = vault[id]?.endpoint;
      const check = await testProviderKey(provider, key, endpointOverride);
      if (check.tested && check.valid === false) return json(res, 400, { error: `${provider.name} ${check.note}`, check });
      vault[id] = { ...(vault[id] || {}), key, savedAt: new Date().toISOString(), verified: check.tested ? true : null };
      writeVault(vault);
      const propagated = propagateKey(id, key);
      return json(res, 200, { saved: true, provider: id, masked: maskKey(key), check, propagated });
    }
    if (path.startsWith("/api/keys/") && req.method === "DELETE") {
      const id = decodeURIComponent(path.slice("/api/keys/".length));
      const vault = readVault();
      if (!vault[id]) return json(res, 404, { error: "no key stored" });
      delete vault[id];
      writeVault(vault);
      return json(res, 200, { removed: id });
    }
    if (path === "/api/action/open-chrome" && req.method === "POST") {
      let body = ""; for await (const c of req) body += c;
      const target = body ? (JSON.parse(body).url ?? null) : null;
      try {
        const result = await openChrome(target);
        return json(res, 200, { opened: true, ...result });
      } catch (err) {
        return json(res, 500, { opened: false, error: String(err?.message ?? err) });
      }
    }
    if (path === "/api/backgrounds" && req.method === "GET") return json(res, 200, { backgrounds: listBackgrounds() });
    if (path === "/api/backgrounds" && req.method === "POST") {
      const name = url.searchParams.get("name") || `bg-${Date.now()}.png`;
      if (!/^[\w. -]+\.(png|jpe?g|webp|tiff?)$/i.test(name)) return json(res, 400, { error: "png/jpg/webp/tiff only" });
      const chunks = []; for await (const c of req) chunks.push(c);
      writeFileSync(join(BACKGROUNDS_DIR, name), Buffer.concat(chunks));
      return json(res, 201, { saved: name });
    }
    if (path.startsWith("/backgrounds/")) {
      const file = decodeURIComponent(path.slice("/backgrounds/".length));
      if (!listBackgrounds().includes(file)) return json(res, 404, { error: "no such background" });
      const real = await servableBackground(file);
      res.writeHead(200, { "content-type": MIME[extname(real).toLowerCase()] || "application/octet-stream" });
      return createReadStream(real).pipe(res);
    }
    // static shell
    const file = path === "/" ? "index.html" : path.slice(1);
    const full = join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR) || !existsSync(full) || !statSync(full).isFile()) return json(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": MIME[extname(full).toLowerCase()] || "text/plain", "cache-control": "no-store" });
    return createReadStream(full).pipe(res);
  } catch (err) {
    return json(res, 500, { error: String(err) });
  }
});

server.listen(PORT, HOST, () => console.log(`[frame] FLOYD frame at http://${HOST}:${PORT}`));
process.on("SIGTERM", () => { for (const c of children.values()) c.kill(); process.exit(0); });
process.on("SIGINT", () => { for (const c of children.values()) c.kill(); process.exit(0); });
