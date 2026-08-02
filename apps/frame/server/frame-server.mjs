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
import { randomBytes } from "node:crypto";
import net from "node:net";
import { createVaultProxy, mergeLiveProviderModels } from "./vault-proxy.mjs";
import { createConnectedAppVault } from "./connected-app-vault.mjs";
import { createModelConnectorVault } from "./model-connector-vault.mjs";
import { createVaultMcpManagement } from "./vault-mcp-management.mjs";
import { createVaultMcpRouter } from "./vault-mcp-router.mjs";
import { createVaultOmpBroker } from "./vault-omf-broker.mjs";
import { createVaultLeakMonitor } from "./vault-leak-monitor.mjs";
import { createUpdater } from "./self-update.mjs";
import { applyVaultEnvironment, buildVaultProfile } from "../../../lib/vault-routing.mjs";
import { publicProviderCatalog, VAULT_PROVIDER_CATALOG } from "../../../lib/vault-provider-catalog.mjs";
import { authorizeManagementBootstrap, authorizeVaultManagement } from "./management-auth.mjs";
import {
  FLOYD_KEYCHAIN_ACCOUNTS,
  MacOSKeychainVault,
} from "./keychain-vault.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const FRAME_DIR = resolve(ROOT, "..");
// Repo root: everything the frame serves or spawns is addressed relative to
// this clone, never to a machine-specific absolute path.
const REPO_ROOT = resolve(FRAME_DIR, "..", "..");
// Runtime home (vault, browser profile, tokens): env override or ~/.floyd.
const RUNTIME_ROOT = process.env.FLOYD_RUNTIME_ROOT || join(homedir(), ".floyd");
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
const SURFACES = join(REPO_ROOT, "intake", "surfaces");
const PTY_COPY = join(SURFACES, "pty");
// Surfaces run on the same node that runs the frame (the app's bundled runtime
// when installed, whatever launched us in dev). Never prefer a system node:
// its ABI may not match the surfaces' native modules.
const NODE_BIN = process.execPath;
const WRAPPER_DIR = join(FRAME_DIR, "server", "shells");
mkdirSync(WRAPPER_DIR, { recursive: true });
mkdirSync(BACKGROUNDS_DIR, { recursive: true });

function wrapperFor(id, execLine) {
  const path = join(WRAPPER_DIR, `${id}.sh`);
  writeFileSync(path, `#!/bin/zsh\n# frame-managed shell for ${id} — TerminalOne spawns this as SHELL\nexec ${execLine}\n`, { mode: 0o755 });
  return path;
}

// ---- provider key vault ------------------------------------------------------
// One place for vendor API keys. Stored in the macOS login Keychain. Managed
// apps receive only owner-scoped fv_ capabilities and the loopback proxy URL.
const SECRETS_DIR = join(RUNTIME_ROOT, "secrets");
const keychainVault = new MacOSKeychainVault();
let providerVault = keychainVault.readJson(FLOYD_KEYCHAIN_ACCOUNTS.providers);
const PROVIDERS = [
  { id: "openai", name: "OpenAI (ChatGPT/Codex)", env: "ChatGPT/Codex subscription",
    prefixes: [], url: null, credentialMode: "chatgpt-subscription" },
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
  return structuredClone(providerVault);
}
function writeVault(vault) {
  keychainVault.writeJson(FLOYD_KEYCHAIN_ACCOUNTS.providers, vault);
  providerVault = structuredClone(vault);
}
const APP_PROFILES_DIR = join(SECRETS_DIR, "proxy-app-profiles");
const CANONICAL_VAULT_APP = Object.freeze({
  "cursem-ide": "cursem",
  "floyd-desktop": "desktop",
  browork: "desktop",
  "harness-launcher": "launcher",
  "floyd-code-cli": "ff",
  ohmyfloyd: "omf",
  terminalone: "terminalone",
  "floyd-tty-bridge": "ttybridge",
  core: "core",
});
function managementToken() {
  return keychainVault.ensureManagementToken();
}
const VAULT_MANAGEMENT_TOKEN = managementToken();
/** Env block injected into every managed app. Real keys NEVER enter an app's
 * environment: each app gets a per-app proxied token plus base URLs that point
 * at the loopback vault proxy, which swaps in the real credential upstream. */
function vaultEnv(appId, inherited = {}) {
  const app = CANONICAL_VAULT_APP[appId] || appId;
  const token = vaultProxy.store.ensure(app);
  const base = VAULT_PROXY_BASE;
  mkdirSync(APP_PROFILES_DIR, { recursive: true, mode: 0o700 });
  const profilePath = join(APP_PROFILES_DIR, `${app}.json`);
  writeFileSync(profilePath, JSON.stringify(buildVaultProfile(app, token, base), null, 2), { mode: 0o600 });
  chmodSync(profilePath, 0o600);
  return applyVaultEnvironment(inherited, app, token, base, profilePath);
}
const maskKey = (k) => (k.length <= 12 ? `${k.slice(0, 3)}…` : `${k.slice(0, 8)}…${k.slice(-4)}`);

// ---- vault credential proxy -------------------------------------------------
// Loopback listener that holds the ONLY path to real provider keys. Apps get
// per-app fv_ tokens (see vault-proxy.mjs); the proxy swaps in the vault key
// on the way upstream. OpenAI rides the ChatGPT subscription exclusively.
const VAULT_PROXY_PORT = Number(process.env.FLOYD_VAULT_PROXY_PORT || 13031);
const VAULT_PROXY_BASE = `http://127.0.0.1:${VAULT_PROXY_PORT}`;
function connectedAppMasterKey() {
  const account = FLOYD_KEYCHAIN_ACCOUNTS.connectedAppMaster;
  const existing = keychainVault.get(account);
  if (existing) {
    const decoded = Buffer.from(existing, "base64");
    if (decoded.byteLength !== 32) throw new Error("Vault connected-app Keychain master key is invalid");
    return decoded;
  }
  const created = randomBytes(32);
  keychainVault.set(account, created.toString("base64"));
  return created;
}
const connectedApps = createConnectedAppVault({
  secretsDir: SECRETS_DIR,
  masterKey: connectedAppMasterKey(),
  returnUrl: `http://127.0.0.1:${PORT}/?settings=connections`,
});
function modelConnectorMasterKey() {
  const account = FLOYD_KEYCHAIN_ACCOUNTS.modelConnectorMaster;
  const existing = keychainVault.get(account);
  if (existing) {
    const decoded = Buffer.from(existing, "base64");
    if (decoded.byteLength !== 32) throw new Error("Vault model-connector Keychain master key is invalid");
    return decoded;
  }
  const created = randomBytes(32);
  keychainVault.set(account, created.toString("base64"));
  return created;
}
const modelConnectors = createModelConnectorVault({
  secretsDir: SECRETS_DIR,
  masterKey: modelConnectorMasterKey(),
  returnUrl: `http://127.0.0.1:${PORT}/?settings=connections`,
});
const mcpManagement = createVaultMcpManagement({
  readTargets: () => keychainVault.readJson(
    FLOYD_KEYCHAIN_ACCOUNTS.remoteMcpTargets,
    { version: 1, targets: {} },
  ),
  writeTargets: (targets) => keychainVault.writeJson(
    FLOYD_KEYCHAIN_ACCOUNTS.remoteMcpTargets,
    targets,
  ),
});
const mcpRouter = createVaultMcpRouter({
  resolveTarget: (input) => mcpManagement.resolveTarget(input),
});
const omfBroker = createVaultOmpBroker({
  providers: PROVIDERS.map((provider) => provider.id),
  getProviderState: async () => {
    const vault = readVault();
    const disabled = new Set(vault.__omf?.disabledProviders || []);
    const subscriptionConfigured = vaultProxy.subscription.configured();
    return Object.fromEntries(PROVIDERS.map(({ id }) => [
      id,
      {
        configured: id === "openai" ? subscriptionConfigured : Boolean(vault[id]?.key),
        enabled: !disabled.has(id),
      },
    ]));
  },
  setProviderEnabled: async (providerId, enabled) => {
    const vault = readVault();
    const disabled = new Set(vault.__omf?.disabledProviders || []);
    if (enabled) disabled.delete(providerId); else disabled.add(providerId);
    vault.__omf = { disabledProviders: [...disabled].sort() };
    writeVault(vault);
    vaultProxy.store.clearProviderRoutes(providerId);
  },
});
function vaultRouteTarget(providerId, defaultTarget) {
  const custom = readVault()[providerId]?.endpoint;
  if (!custom) return defaultTarget;
  const provider = PROVIDERS.find((entry) => entry.id === providerId);
  const defaultRoot = (provider && defaultEndpoint(provider))
    || VAULT_PROVIDER_CATALOG[providerId]?.upstream;
  if (!defaultRoot || !defaultTarget.startsWith(defaultRoot)) {
    throw new Error(`Vault custom endpoint cannot map provider ${providerId}`);
  }
  return `${custom}${defaultTarget.slice(defaultRoot.length)}`;
}
const vaultProxy = createVaultProxy({
  secretsDir: SECRETS_DIR,
  realKey: (providerId) => readVault()[providerId]?.key || null,
  subscriptionStore: {
    read: () => keychainVault.readJson(FLOYD_KEYCHAIN_ACCOUNTS.subscription),
    write: (auth) => keychainVault.writeJson(FLOYD_KEYCHAIN_ACCOUNTS.subscription, auth),
  },
  connectedApps,
  modelConnectors,
  mcpRouter,
  omfBroker,
  routeTarget: vaultRouteTarget,
  port: VAULT_PROXY_PORT,
});
// Core is launchd-managed rather than a Frame child, so materialize its
// owner-only capability profile at Vault startup.
vaultEnv("core", {});
vaultEnv("ttybridge", {});

// Self-updater: no-op in dev checkouts (no VERSION file); the installed app
// checks www.floydslabs.com for a newer signed pkg on demand.
const updater = createUpdater({
  repoRoot: REPO_ROOT,
  runtimeRoot: RUNTIME_ROOT,
  manifestUrl: process.env.FLOYD_UPDATE_MANIFEST_URL || undefined,
});

/** Vendor auto-detection from key shape. Returns {match} on a unique prefix hit,
 * {candidates} when the shape fits several vendors (e.g. bare "sk-"). */
function detectProvider(key) {
  const apiKeyProviders = PROVIDERS.filter((provider) => provider.credentialMode !== "chatgpt-subscription");
  const exact = apiKeyProviders.filter((p) => p.prefixes.some((x) => key.startsWith(x)));
  if (exact.length === 1) return { match: exact[0] };
  const loose = apiKeyProviders.filter((p) => (p.ambiguous || []).some((x) => key.startsWith(x)));
  if (exact.length === 0 && loose.length === 1) return { match: loose[0] };
  const candidates = [...new Set([...exact, ...loose])];
  return { candidates: candidates.length ? candidates : apiKeyProviders };
}
async function testProviderKey(provider, key, endpointOverride) {
  if (!provider.test) return { tested: false, note: "no live test for this vendor" };
  const spec = provider.test(key);
  // A custom endpoint replaces the URL's origin+path root while keeping the
  // vendor-specific auth headers and request shape.
  const url = endpointOverride ? spec.url.replace(defaultEndpoint(provider), endpointOverride) : spec.url;
  const publicEndpoint = (() => {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  })();
  try {
    const res = await fetch(url, {
      method: spec.method || "GET",
      headers: spec.headers || {},
      body: spec.body,
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return { tested: true, valid: true, endpoint: publicEndpoint };
    return { tested: true, valid: false, status: res.status, endpoint: publicEndpoint, note: res.status === 401 || res.status === 403 ? "rejected by vendor (bad or expired key)" : `vendor answered HTTP ${res.status}` };
  } catch (err) {
    return { tested: false, endpoint: publicEndpoint, note: `could not reach vendor: ${String(err?.message ?? err).slice(0, 120)}` };
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

function normalizeCustomEndpoint(input) {
  const value = String(input || "").trim();
  if (!value) return "";
  const endpoint = new URL(value);
  const host = endpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new Error("custom endpoint must use HTTPS or loopback HTTP");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("custom endpoint cannot contain credentials, query, or fragment");
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");
  return endpoint.toString().replace(/\/$/, "");
}

// Shared loopback token so trusted frame apps (the IDE's terminal pane) can
// attach to the canonical terminal without the browser origin+ticket flow.
const TERMINAL_APP_TOKEN = randomBytes(24).toString("base64url");

const MANAGED = {
  "cursem-ide": {
    port: 13012,
    cwd: join(SURFACES, "ide"),
    cmd: NODE_BIN, args: ["server/cursem-server.mjs"],
    env: {
      FLOYD_SURFACE_SOURCE_ROOT: join(SURFACES, "ide"),
      CURSEM_PORT: "13012",
      CURSEM_TERMINAL_PORT: "13013",
      // The IDE's terminal pane attaches to the canonical terminal server
      // (launched first via DEPENDS_ON) using the shared loopback token.
      CURSEM_TERMINAL_URL: "ws://127.0.0.1:13013",
      CURSEM_TERMINAL_TOKEN: TERMINAL_APP_TOKEN,
      // Allow embedding ONLY by local frame origins. Remote access is disabled
      // until a private overlay is configured.
      CURSEM_FRAME_ANCESTORS: "http://127.0.0.1:13030 http://localhost:13030 http://floyd.localhost:13030",
    },
  },
  "floyd-desktop": {
    port: 13010,
    cwd: join(SURFACES, "desktop"),
    cmd: NODE_BIN, args: ["dist-server/index.js"],
    env: { FLOYD_SURFACE_SOURCE_ROOT: join(SURFACES, "desktop"), PORT: "13010", MCP_WS_PORT: "13011" },
  },
  "harness-launcher": {
    port: 13014,
    cwd: join(SURFACES, "launcher"),
    cmd: NODE_BIN, args: ["src/server.js"],
    env: { FLOYD_SURFACE_SOURCE_ROOT: join(SURFACES, "launcher"), PORT: "13014", HOST: "127.0.0.1" },
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
    // Plain shell — no SHELL override, TerminalOne falls back to zsh. Trusted
    // frame apps (the IDE's terminal pane) attach with the shared token
    // instead of the browser origin+ticket flow.
    env: { FLOYD_SURFACE_SOURCE_ROOT: join(SURFACES, "pty"), PORT: "13013", TERMINALONE_ALLOWED_ORIGIN: "http://127.0.0.1:13013", TERMINALONE_AUTH_TOKEN: TERMINAL_APP_TOKEN },
  },
};

// Browork is a page inside Floyd Desktop — launching it ensures the same
// server (ensureApp is idempotent: it checks the port before spawning).
MANAGED["browork"] = MANAGED["floyd-desktop"];

const children = new Map(); // id -> ChildProcess

// Launch dependencies: an app only spawns after its backing services are up,
// so the IDE always finds the canonical terminal waiting on 13013.
const DEPENDS_ON = { "cursem-ide": ["terminalone"] };

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
  for (const dep of DEPENDS_ON[id] || []) await ensureApp(dep);
  const requested = { ...process.env, ...(typeof spec.env === "function" ? spec.env() : spec.env), FLOYD_RUNTIME_ROOT: RUNTIME_ROOT };
  // Each surface must report live identity from the current checkout, not stale parent
  // environment values that can linger across restarts.
  delete requested.FLOYD_SURFACE_COMMIT;
  delete requested.FLOYD_SOURCE_COMMIT;
  const env = vaultEnv(id, requested);
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

async function stopManagedSurface(id) {
  const spec = MANAGED[id];
  if (!spec) return { stopped: false, reason: "not-frame-managed" };
  const child = children.get(id);
  if (child) {
    try { child.kill("SIGTERM"); } catch {}
    children.delete(id);
  } else {
    await new Promise((done) => {
      execFile("lsof", ["-nP", "-ti", `tcp:${spec.port}`, "-sTCP:LISTEN"], (_error, stdout) => {
        const pid = Number((stdout || "").trim().split("\n")[0]);
        if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} }
        done();
      });
    });
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await portOpen(spec.port))) return { stopped: true };
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return { stopped: false, reason: "port-still-open" };
}

function routeStatusByProvider() {
  const tokens = vaultProxy.store.list();
  const status = {};
  for (const provider of PROVIDERS) {
    const applications = tokens
      .filter((token) => !token.revoked && Number(token.routes?.[provider.id]?.success_count || 0) > 0)
      .map((token) => token.app)
      .sort();
    status[provider.id] = {
      routable: applications.length > 0,
      applicationTested: applications,
    };
  }
  return status;
}

async function rotateCompromisedApplication(app, detail = {}) {
  const canonical = CANONICAL_VAULT_APP[app] || app;
  const surfaceId = Object.keys(CANONICAL_VAULT_APP)
    .find((id) => id !== "browork" && CANONICAL_VAULT_APP[id] === canonical && MANAGED[id]);
  const wasRunning = surfaceId ? await portOpen(MANAGED[surfaceId].port) : false;
  const rotation = vaultProxy.store.rotate(canonical, {
    source: detail.source || "vault-compromise-report",
    reason: detail.reason || "proxied credential reported leaked",
    alertId: detail.alertId,
  });
  vaultEnv(canonical, {});
  let restart = { attempted: false, ok: true, reason: "application-not-running" };
  if (canonical === "core") {
    restart = await new Promise((resolveRestart) => {
      execFile("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/com.floyd.core`], (error) => {
        resolveRestart({ attempted: true, ok: !error, reason: error ? "launchctl-kickstart-failed" : "launchctl-kickstart" });
      });
    });
  } else if (canonical === "ttybridge") {
    const browserWasRunning = await portOpen(INTERNAL_BROWSER_CDP_PORT);
    if (browserWasRunning) {
      const stopped = await closeInternalBrowser();
      const launched = stopped ? await openChrome("") : null;
      restart = {
        attempted: true,
        ok: Boolean(stopped && launched?.loaded?.length === INTERNAL_EXTENSIONS.length),
        reason: stopped ? "internal-browser-restarted" : "internal-browser-close-failed",
      };
    }
  } else if (surfaceId && wasRunning) {
    const stopped = await stopManagedSurface(surfaceId);
    const launched = stopped.stopped ? await ensureApp(surfaceId) : { up: false, error: stopped.reason };
    restart = { attempted: true, ok: launched.up === true, reason: launched.error || "frame-restarted" };
  }
  return {
    application: canonical,
    replacementTime: new Date().toISOString(),
    previousTokenRevocation: {
      ok: rotation.revokedCount > 0,
      count: rotation.revokedCount,
      terminatedConnections: rotation.terminatedConnections,
    },
    restart,
  };
}

const leakMonitor = createVaultLeakMonitor({
  roots: [
    REPO_ROOT,
    join(RUNTIME_ROOT, "logs"),
    join(homedir(), "Library", "Logs", "floyd"),
  ],
  getActiveCapabilities: () => vaultProxy.store.activeCapabilities(),
  recordAlert: (kind, detail) => vaultProxy.store.alert(kind, detail),
  onConfirmedLeak: (app, detail) => rotateCompromisedApplication(app, detail),
});

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
const INTERNAL_BROWSER_PROFILE = join(RUNTIME_ROOT, "internal-browser-profile");
const INTERNAL_BROWSER_CDP_PORT = 13032;
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

/** Closing the dedicated browser terminates extension WebSockets immediately.
 * It is used after a confirmed TTY Bridge capability compromise so an already
 * authenticated Live session cannot outlive the revoked fv_ credential. */
async function closeInternalBrowser() {
  let version;
  try { version = await cdpHttp("/json/version"); } catch { return true; }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  try {
    await new Promise((done, fail) => {
      ws.onopen = done;
      ws.onerror = () => fail(new Error("CDP websocket failed"));
    });
    ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
  } catch {
    try { ws.close(); } catch {}
    return false;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await portOpen(INTERNAL_BROWSER_CDP_PORT))) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  try { ws.close(); } catch {}
  return false;
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
const CHRONO_PY = existsSync("/opt/homebrew/bin/python3") ? "/opt/homebrew/bin/python3" : "python3";
const CHRONO_CLI = join(REPO_ROOT, "ops", "chrono", "chrono_sandbox.py");
const CHRONO_SURFACES = {
  ide: join(SURFACES, "ide"),
  desktop: join(SURFACES, "desktop"),
  launcher: join(SURFACES, "launcher"),
  pty: PTY_COPY,
  workstation: REPO_ROOT,
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
    if ((path.startsWith("/api/keys") || (path.startsWith("/api/vault") && path !== "/api/vault/catalog"))
      && !authorizeVaultManagement(req.headers, VAULT_MANAGEMENT_TOKEN)) {
      return json(res, 403, { error: "Vault management authorization required" });
    }
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
    if (path === "/api/vault/catalog" && req.method === "GET") {
      const vault = readVault();
      const routeStatus = routeStatusByProvider();
      // Merge the vault proxy's live model broker into the static catalog so
      // choosers see real, current models. Additive only: a per-provider
      // "source" field ("live"|"fallback") marks where the list came from.
      const live = await vaultProxy.liveProviderModels(PROVIDERS.map((provider) => provider.id));
      return json(res, 200, {
        version: 1,
        proxyUrl: VAULT_PROXY_BASE,
        providers: mergeLiveProviderModels(publicProviderCatalog(Object.fromEntries(PROVIDERS.map((provider) => [
          provider.id,
          {
            configured: provider.id === "openai"
              ? vaultProxy.subscription.configured()
              : Boolean(vault[provider.id]?.key),
            verified: provider.id === "openai"
              ? vaultProxy.subscription.configured()
              : vault[provider.id]?.verified ?? null,
            ...routeStatus[provider.id],
          },
        ]))), live),
      });
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
      const routeStatus = routeStatusByProvider();
      const subscriptionConfigured = vaultProxy.subscription.configured();
      const chatgptSubscription = { configured: subscriptionConfigured, authority: "floyd-vault-keychain" };
      return json(res, 200, {
        chatgptSubscription,
        providers: PROVIDERS.map((p) => ({
          id: p.id, name: p.name, env: p.env, envAliases: p.envAliases || [], url: p.url, testable: Boolean(p.test),
          credentialMode: p.credentialMode || "api-key",
          managementAction: p.id === "openai" ? "/api/keys/openai/subscription" : null,
          endpoint: p.id === "openai"
            ? "ChatGPT subscription via Floyd Vault"
            : vault[p.id]?.endpoint || defaultEndpoint(p),
          defaultEndpoint: defaultEndpoint(p),
          customEndpoint: p.id !== "openai" && Boolean(vault[p.id]?.endpoint),
          configured: p.id === "openai" ? subscriptionConfigured : Boolean(vault[p.id]?.key),
          masked: p.id === "openai" ? null : vault[p.id]?.key ? maskKey(vault[p.id].key) : null,
          verified: p.id === "openai" ? subscriptionConfigured : vault[p.id]?.verified ?? null,
          routable: routeStatus[p.id]?.routable ?? false,
          applicationTested: routeStatus[p.id]?.applicationTested ?? [],
          active: (p.id === "openai"
            ? subscriptionConfigured
            : Boolean(vault[p.id]?.key) && vault[p.id]?.verified === true)
            && routeStatus[p.id]?.routable === true,
          savedAt: p.id === "openai" ? null : vault[p.id]?.savedAt ?? null,
        })),
      });
    }
    if (path === "/api/keys/openai/subscription" && req.method === "POST") {
      const handoffScript = join(REPO_ROOT, "scripts", "vault-provider-handoff.mjs");
      const handoffEnv = Object.fromEntries(
        ["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_CTYPE"]
          .filter((name) => typeof process.env[name] === "string")
          .map((name) => [name, process.env[name]]),
      );
      handoffEnv.FRAME_PORT = String(PORT);
      const launched = await new Promise((done) => {
        const child = spawn(NODE_BIN, [handoffScript, "frame", "chatgpt-subscription"], {
          env: handoffEnv,
          stdio: "ignore",
          shell: false,
        });
        child.once("error", (error) => done({ ok: false, error: error.message }));
        child.once("exit", (code) => done(code === 0
          ? { ok: true }
          : { ok: false, error: `native handoff exited ${code ?? 1}` }));
      });
      if (!launched.ok) return json(res, 500, { error: launched.error });
      return json(res, 200, {
        configured: vaultProxy.subscription.configured(),
        authority: "floyd-vault-keychain",
        launched: "ChatGPT/Codex",
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
      const provider = PROVIDERS.find((entry) => entry.id === id);
      if (!provider || id === "openai") return json(res, 404, { error: `unknown provider ${id}` });
      let body = ""; for await (const chunk of req) body += chunk;
      let endpoint;
      try {
        endpoint = normalizeCustomEndpoint(JSON.parse(body || "{}").endpoint);
      } catch (error) {
        return json(res, 400, { error: String(error?.message ?? error) });
      }
      if (endpoint === defaultEndpoint(provider)) endpoint = "";
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
      vaultProxy.store.clearProviderRoutes(id);
      return json(res, 200, {
        provider: id,
        endpoint: endpoint || defaultEndpoint(provider),
        custom: Boolean(endpoint),
        check,
      });
    }
    if (path.startsWith("/api/keys/") && req.method === "POST") {
      const id = decodeURIComponent(path.slice("/api/keys/".length));
      const provider = PROVIDERS.find((p) => p.id === id);
      if (!provider) return json(res, 404, { error: `unknown provider ${id}` });
      if (id === "openai") {
        return json(res, 409, { error: "OpenAI uses the configured ChatGPT subscription exclusively; API keys are not accepted" });
      }
      let body = ""; for await (const c of req) body += c;
      const key = (JSON.parse(body || "{}").key || "").trim();
      if (!key || key.length < 8 || /\s/.test(key)) return json(res, 400, { error: "that does not look like an API key" });
      const vault = readVault();
      const check = await testProviderKey(provider, key, readVault()[id]?.endpoint);
      if (check.tested && check.valid === false) return json(res, 400, { error: `${provider.name} ${check.note}`, check });
      vault[id] = { ...(vault[id] || {}), key, savedAt: new Date().toISOString(), verified: check.tested ? true : null };
      writeVault(vault);
      vaultProxy.store.clearProviderRoutes(id);
      return json(res, 200, { saved: true, provider: id, masked: maskKey(key), check, propagated: [] });
    }
    if (path.startsWith("/api/keys/") && req.method === "DELETE") {
      const id = decodeURIComponent(path.slice("/api/keys/".length));
      if (id === "openai") {
        return json(res, 409, { error: "OpenAI is controlled by the ChatGPT subscription; there is no Vault API key to delete" });
      }
      const vault = readVault();
      if (!vault[id]) return json(res, 404, { error: "no key stored" });
      delete vault[id];
      writeVault(vault);
      vaultProxy.store.clearProviderRoutes(id);
      return json(res, 200, { removed: id });
    }
    // ---- vault proxy management ----------------------------------------
    // Proxied tokens for third-party apps: issue/rotate shows the plaintext
    // exactly once; list/alerts expose usage + leak-detection signals.
    if (path === "/api/vault/tokens" && req.method === "GET") {
      return json(res, 200, { proxy: VAULT_PROXY_BASE, tokens: vaultProxy.store.list() });
    }
    if (path === "/api/vault/tokens" && req.method === "POST") {
      let body = ""; for await (const c of req) body += c;
      const app = (JSON.parse(body || "{}").app || "").trim();
      try {
        const token = vaultProxy.store.issue(app);
        return json(res, 201, {
          app, token, proxy: VAULT_PROXY_BASE,
          note: "shown once — point the app's base URL at the proxy and use this as its API key",
          openaiBaseUrl: `${VAULT_PROXY_BASE}/v1`,
          anthropicBaseUrl: VAULT_PROXY_BASE,
        });
      } catch (err) {
        return json(res, 400, { error: String(err?.message ?? err) });
      }
    }
    if (path.startsWith("/api/vault/tokens/") && req.method === "DELETE") {
      const app = decodeURIComponent(path.slice("/api/vault/tokens/".length));
      const revoked = vaultProxy.store.revoke(app);
      return revoked ? json(res, 200, { revoked: app, count: revoked }) : json(res, 404, { error: `no active token for ${app}` });
    }
    if (path === "/api/vault/alerts" && req.method === "GET") {
      return json(res, 200, { alerts: vaultProxy.store.alerts(Number(url.searchParams.get("limit")) || 100) });
    }
    if (path === "/api/vault/mcp-targets" && req.method === "GET") {
      return json(res, 200, { targets: await mcpManagement.list() });
    }
    if (path.startsWith("/api/vault/mcp-targets/") && req.method === "PUT") {
      const id = decodeURIComponent(path.slice("/api/vault/mcp-targets/".length));
      let body = ""; for await (const chunk of req) body += chunk;
      try {
        return json(res, 200, await mcpManagement.upsert(id, JSON.parse(body || "{}")));
      } catch (error) {
        return json(res, 400, { error: String(error?.message ?? error) });
      }
    }
    if (path.startsWith("/api/vault/mcp-targets/") && req.method === "DELETE") {
      const id = decodeURIComponent(path.slice("/api/vault/mcp-targets/".length));
      try {
        return await mcpManagement.remove(id)
          ? json(res, 200, { removed: id })
          : json(res, 404, { error: `no MCP target ${id}` });
      } catch (error) {
        return json(res, 400, { error: String(error?.message ?? error) });
      }
    }
    if (path === "/api/vault/compromise" && req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      let report;
      try { report = JSON.parse(body || "{}"); } catch { return json(res, 400, { error: "invalid JSON" }); }
      const app = String(report.app || "").trim();
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(app)) return json(res, 400, { error: "invalid application" });
      try {
        return json(res, 200, await rotateCompromisedApplication(app));
      } catch (error) {
        return json(res, 404, { error: String(error?.message ?? error) });
      }
    }
    // ---- agent model preferences ---------------------------------------
    // Shipped agent.json model pins are defaults only. Users override them
    // here; merge-config.mjs layers this file over every agent overlay.
    //   GET  -> { default: {...}, agents: { slug: {...} } }
    //   PUT  -> replace the whole preference document (validated JSON object)
    if (path === "/api/agent-models" && req.method === "GET") {
      try { return json(res, 200, JSON.parse(readFileSync(join(RUNTIME_ROOT, "agent-models.json"), "utf8"))); }
      catch { return json(res, 200, { default: {}, agents: {} }); }
    }
    if (path === "/api/agent-models" && req.method === "PUT") {
      let body = ""; for await (const c of req) body += c;
      let prefs;
      try { prefs = JSON.parse(body); } catch { return json(res, 400, { error: "invalid JSON" }); }
      if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) return json(res, 400, { error: "expected an object" });
      writeFileSync(join(RUNTIME_ROOT, "agent-models.json"), JSON.stringify(prefs, null, 2));
      return json(res, 200, { ok: true, prefs });
    }
    // ---- self-update ----------------------------------------------------
    // GET  /api/update         -> current/available/downloaded state (checks)
    // POST /api/update/install -> download verified pkg, open Installer.app
    if (path === "/api/update" && req.method === "GET") {
      return json(res, 200, await updater.check());
    }
    if (path === "/api/update/install" && req.method === "POST") {
      try {
        if (!updater.state.available) await updater.check();
        if (!updater.state.available) return json(res, 409, { error: updater.state.error || "already up to date", state: updater.state });
        const pkg = await updater.download();
        spawn("open", [pkg], { detached: true, stdio: "ignore" }).unref();
        return json(res, 200, { ok: true, pkg, note: "Installer.app opened; user completes the install" });
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) });
      }
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
    res.writeHead(200, {
      "content-type": MIME[extname(full).toLowerCase()] || "text/plain",
      "cache-control": "no-store",
      ...(file === "index.html" ? {
        "set-cookie": authorizeManagementBootstrap(req.headers, VAULT_MANAGEMENT_TOKEN)
          ? `floyd_management=${VAULT_MANAGEMENT_TOKEN}; HttpOnly; SameSite=Strict; Path=/api`
          : "floyd_management=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0",
      } : {}),
    });
    return createReadStream(full).pipe(res);
  } catch (err) {
    return json(res, 500, { error: String(err) });
  }
});

server.listen(PORT, HOST, () => console.log(`[frame] FLOYD frame at http://${HOST}:${PORT}`));
vaultProxy.listen().then(() => console.log(`[frame] vault proxy at ${VAULT_PROXY_BASE} (loopback only)`))
  .catch((err) => { console.error(`[frame] FATAL: vault proxy failed to bind: ${err?.message ?? err}`); process.exit(1); });
leakMonitor.start();
process.on("SIGTERM", () => { leakMonitor.close(); for (const c of children.values()) c.kill(); process.exit(0); });
process.on("SIGINT", () => { leakMonitor.close(); for (const c of children.values()) c.kill(); process.exit(0); });
