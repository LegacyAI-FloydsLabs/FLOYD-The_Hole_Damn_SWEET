// FLOYD Vault credential proxy.
//
// The feature that makes THE VAULT the vault: real provider keys live only in
// this process. Every app (FLOYD-managed or third-party) gets a per-app
// proxied token (fv_<app>_<random>) and talks to this loopback listener; the
// proxy swaps the token for the real credential on the way out.
//
// - Loopback only. A leaked proxied token is useless off this machine.
// - Tokens are stored hashed (sha256); the plaintext is shown exactly once.
// - Per-token last_used/use_count + an alert log for bad-token attempts give
//   the leak-detection signal.
// - Rotation: revoke + reissue one token. Real keys never leave the vault, so
//   harnesses are never touched by a provider-key rotation.
// - OpenAI: the ChatGPT subscription (Codex OAuth token lineage) is the sole
//   OpenAI credential. /v1/responses is the native surface; openai/* models on
//   /v1/chat/completions are translated to it.
//
// Routes:
//   GET  /healthz                      liveness (no auth)
//   POST /v1/chat/completions          model "provider/model" (openai dialect)
//   POST /v1/messages                  model "provider/model" (anthropic dialect)
//   POST /v1/responses                 ChatGPT subscription passthrough
//   ANY  /p/<provider>/<path>          generic passthrough w/ auth injection

import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const VAULT_PROXY_VERSION = "1.0.0";
const MAX_BODY = 25 * 1024 * 1024;

const bearer = (h, k) => { h.authorization = `Bearer ${k}`; };
/** Upstream map: where each provider's traffic really goes and how the real
 * key is attached. `openai`/`anthropic` are dialect endpoints for the shared
 * /v1/chat/completions and /v1/messages routes. */
export const UPSTREAMS = {
  anthropic:   { base: "https://api.anthropic.com", anthropic: "https://api.anthropic.com/v1/messages",
                 inject: (h, k) => { h["x-api-key"] = k; if (!h["anthropic-version"]) h["anthropic-version"] = "2023-06-01"; } },
  google:      { base: "https://generativelanguage.googleapis.com", inject: (h, k) => { h["x-goog-api-key"] = k; } },
  deepseek:    { base: "https://api.deepseek.com", openai: "https://api.deepseek.com/chat/completions", inject: bearer },
  mistral:     { base: "https://api.mistral.ai", openai: "https://api.mistral.ai/v1/chat/completions", inject: bearer },
  huggingface: { base: "https://router.huggingface.co", openai: "https://router.huggingface.co/v1/chat/completions", inject: bearer },
  github:      { base: "https://api.github.com", inject: (h, k) => { h.authorization = `Bearer ${k}`; if (!h["user-agent"]) h["user-agent"] = "floyd-vault-proxy"; } },
  elevenlabs:  { base: "https://api.elevenlabs.io", inject: (h, k) => { h["xi-api-key"] = k; } },
  zai:         { base: "https://api.z.ai", openai: "https://api.z.ai/api/coding/paas/v4/chat/completions",
                 anthropic: "https://api.z.ai/api/anthropic/v1/messages", inject: bearer },
  minimax:     { base: "https://api.minimax.io", anthropic: "https://api.minimax.io/anthropic/v1/messages", inject: bearer },
  moonshot:    { base: "https://api.moonshot.ai", openai: "https://api.moonshot.ai/v1/chat/completions", inject: bearer },
  tavily:      { base: "https://api.tavily.com", inject: bearer },
  openrouter:  { base: "https://openrouter.ai/api", openai: "https://openrouter.ai/api/v1/chat/completions", inject: bearer },
  xai:         { base: "https://api.x.ai", openai: "https://api.x.ai/v1/chat/completions", inject: bearer },
  groq:        { base: "https://api.groq.com", openai: "https://api.groq.com/openai/v1/chat/completions", inject: bearer },
  fal:         { base: "https://fal.run", inject: (h, k) => { h.authorization = `Key ${k}`; } },
};

// ---- ChatGPT subscription (sole OpenAI credential) -------------------------
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // Codex CLI public client id (not a secret)
const SUBSCRIPTION_BACKEND = "https://chatgpt.com/backend-api/codex/responses";

class SubscriptionAuth {
  constructor(authFile) {
    this.authFile = authFile || process.env.CHATGPT_AUTH_FILE || join(homedir(), ".codex", "auth.json");
    this.refreshing = null;
  }
  read() { return JSON.parse(readFileSync(this.authFile, "utf8")); }
  configured() {
    try { const a = this.read(); return Boolean(a.tokens?.access_token && a.tokens?.refresh_token); }
    catch { return false; }
  }
  async accessToken() {
    let auth = this.read();
    const exp = jwtExp(auth.tokens.access_token);
    if (exp !== null && exp * 1000 - Date.now() < 5 * 60 * 1000) {
      this.refreshing ??= this.refresh().finally(() => { this.refreshing = null; });
      await this.refreshing;
      auth = this.read();
    }
    return { token: auth.tokens.access_token, accountId: auth.tokens.account_id };
  }
  async refresh() {
    const auth = this.read();
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", client_id: OAUTH_CLIENT_ID,
        refresh_token: auth.tokens.refresh_token, scope: "openid profile email" }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`subscription token refresh failed: HTTP ${res.status}`);
    const data = await res.json();
    if (!data.access_token) throw new Error("subscription token refresh returned no access_token");
    auth.tokens.access_token = data.access_token;
    if (data.refresh_token) auth.tokens.refresh_token = data.refresh_token;
    if (data.id_token) auth.tokens.id_token = data.id_token;
    auth.last_refresh = new Date().toISOString();
    writeFileSync(this.authFile, JSON.stringify(auth, null, 2), { mode: 0o600 });
  }
}
function jwtExp(token) {
  try {
    const payload = token.split(".")[1];
    const claims = JSON.parse(Buffer.from(payload + "=".repeat((4 - (payload.length % 4)) % 4), "base64url").toString());
    return typeof claims.exp === "number" ? claims.exp : null;
  } catch { return null; }
}

// ---- proxied token store (hashes only) -------------------------------------
class TokenStore {
  constructor(secretsDir) {
    this.path = join(secretsDir, "proxy-tokens.json");
    this.alertPath = join(secretsDir, "proxy-alerts.log");
    this.secretsDir = secretsDir;
  }
  load() {
    try { return JSON.parse(readFileSync(this.path, "utf8")); } catch { return { tokens: [] }; }
  }
  save(db) {
    mkdirSync(this.secretsDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(db, null, 2), { mode: 0o600 });
  }
  /** Create (or rotate) the token for an app name. Plaintext returned ONCE. */
  issue(app) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(app)) throw new Error("app name must be alphanumeric/dash/underscore");
    const db = this.load();
    for (const t of db.tokens) if (t.app === app && !t.revoked) { t.revoked = true; t.revoked_at = new Date().toISOString(); }
    const plaintext = `fv_${app}_${randomBytes(24).toString("hex")}`;
    db.tokens.push({
      id: randomBytes(6).toString("hex"), app, hash: sha256(plaintext),
      created_at: new Date().toISOString(), last_used_at: null, use_count: 0, revoked: false,
    });
    this.save(db);
    return plaintext;
  }
  revoke(app) {
    const db = this.load();
    let n = 0;
    for (const t of db.tokens) if (t.app === app && !t.revoked) { t.revoked = true; t.revoked_at = new Date().toISOString(); n++; }
    this.save(db);
    // Drop any cached plaintext so a frame-managed app cannot resurrect it.
    const cache = this.#cache();
    if (cache[app]) { delete cache[app]; this.#saveCache(cache); }
    return n;
  }
  /** Stable token for frame-managed apps: reuse the cached plaintext across
   * restarts (cache lives beside the vault, 0600, same trust domain as the
   * real keys it replaces). Rotation = revoke() then ensure(). */
  ensure(app) {
    const cache = this.#cache();
    const cached = cache[app];
    if (cached) {
      const h = Buffer.from(sha256(cached), "hex");
      const live = this.load().tokens.some((t) => !t.revoked && t.app === app && timingSafeEqual(Buffer.from(t.hash, "hex"), h));
      if (live) return cached;
    }
    const plaintext = this.issue(app);
    cache[app] = plaintext;
    this.#saveCache(cache);
    return plaintext;
  }
  #cachePath() { return join(this.secretsDir, "proxy-app-tokens.json"); }
  #cache() { try { return JSON.parse(readFileSync(this.#cachePath(), "utf8")); } catch { return {}; } }
  #saveCache(cache) {
    mkdirSync(this.secretsDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.#cachePath(), JSON.stringify(cache, null, 2), { mode: 0o600 });
  }
  list() {
    return this.load().tokens.map(({ hash, ...rest }) => rest);
  }
  verify(plaintext) {
    if (typeof plaintext !== "string" || !plaintext.startsWith("fv_")) return null;
    const h = Buffer.from(sha256(plaintext), "hex");
    const db = this.load();
    for (const t of db.tokens) {
      const th = Buffer.from(t.hash, "hex");
      if (th.length === h.length && timingSafeEqual(th, h)) {
        if (t.revoked) return { revoked: t };
        t.last_used_at = new Date().toISOString();
        t.use_count = (t.use_count || 0) + 1;
        this.save(db);
        return { token: t };
      }
    }
    return null;
  }
  alert(kind, detail) {
    mkdirSync(this.secretsDir, { recursive: true, mode: 0o700 });
    appendFileSync(this.alertPath, JSON.stringify({ at: new Date().toISOString(), kind, ...detail }) + "\n", { mode: 0o600 });
  }
  alerts(limit = 100) {
    try {
      return readFileSync(this.alertPath, "utf8").trim().split("\n").slice(-limit).map((l) => JSON.parse(l));
    } catch { return []; }
  }
}
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// ---- proxy server ----------------------------------------------------------
export function createVaultProxy({ secretsDir, realKey, upstreams = UPSTREAMS, authFile, port = 13031, host = "127.0.0.1" }) {
  const store = new TokenStore(secretsDir);
  const subscription = new SubscriptionAuth(authFile);

  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://x").pathname;
      if (req.method === "GET" && path === "/healthz") {
        return json(res, 200, { ok: true, version: VAULT_PROXY_VERSION, service: "floyd-vault-proxy" });
      }

      // authenticate the proxied token from whatever header style the SDK used
      const presented = presentedToken(req.headers);
      const verdict = presented ? store.verify(presented) : null;
      if (!verdict || verdict.revoked) {
        store.alert(verdict?.revoked ? "revoked_token_used" : presented ? "unknown_token" : "missing_token", {
          path, app: verdict?.revoked?.app ?? null,
        });
        return json(res, 401, { error: { message: "Vault proxy: invalid or missing proxied token." } });
      }
      const app = verdict.token.app;

      if (path === "/v1/responses") return subscriptionPassthrough(req, res, subscription);
      if (path === "/v1/chat/completions" || path === "/v1/messages") {
        const dialect = path === "/v1/messages" ? "anthropic" : "openai";
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        // Bare model names (app pointed at us via a base-URL override) get a
        // provider inferred from the model family (glm->zai, claude->anthropic...).
        const [prefix, model] = splitModel(body.model);
        const providerId = prefix || inferProvider(model, dialect);
        if (providerId === "openai") return subscriptionChat(req, res, subscription, { ...body, model });
        const up = upstreams[providerId];
        const target = up?.[dialect];
        if (!target) return json(res, 400, { error: { message: `no ${dialect} route for provider ${providerId}` } });
        const key = realKey(providerId);
        if (!key) return json(res, 503, { error: { message: `vault has no key for ${providerId}` } });
        return forward(req, res, target, up, key, JSON.stringify({ ...body, model }), app);
      }
      const generic = path.match(/^\/p\/([a-z0-9-]+)(\/.*)?$/);
      if (generic) {
        const [, providerId, rest] = generic;
        const up = upstreams[providerId];
        if (!up) return json(res, 404, { error: { message: `unknown provider ${providerId}` } });
        const key = realKey(providerId);
        if (!key) return json(res, 503, { error: { message: `vault has no key for ${providerId}` } });
        const target = up.base + (rest || "/") + (new URL(req.url, "http://x").search || "");
        const body = req.method === "GET" || req.method === "HEAD" ? null : await readBody(req);
        return forward(req, res, target, up, key, body, app);
      }
      return json(res, 404, { error: { message: "not found" } });
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: { message: String(err?.message ?? err).slice(0, 300) } });
      else res.destroy();
    }
  });

  return {
    server, store, subscription,
    listen: () => new Promise((resolve) => server.listen(port, host, () => resolve(server.address()))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Pull a candidate fv_ token out of any auth header an SDK might use. */
function presentedToken(headers) {
  const auth = headers.authorization || "";
  for (const c of [auth.replace(/^Bearer\s+/i, "").replace(/^Key\s+/i, ""), headers["x-api-key"], headers["xi-api-key"], headers["x-goog-api-key"]]) {
    if (typeof c === "string" && c.startsWith("fv_")) return c;
  }
  return null;
}

function splitModel(model) {
  if (typeof model !== "string") return [null, null];
  const i = model.indexOf("/");
  return i > 0 ? [model.slice(0, i), model.slice(i + 1)] : [null, model];
}

/** Providers for bare model names from apps that only let you override the
 * base URL (no provider prefix). Family name -> vault provider. */
export function inferProvider(model, dialect) {
  const m = String(model || "").toLowerCase();
  if (m.startsWith("glm")) return "zai";
  if (m.startsWith("minimax")) return "minimax";
  if (m.startsWith("kimi") || m.startsWith("moonshot")) return "moonshot";
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4") || m.startsWith("codex")) return "openai";
  if (m.startsWith("gemini")) return "google";
  if (m.startsWith("deepseek")) return "deepseek";
  if (m.startsWith("mistral") || m.startsWith("codestral")) return "mistral";
  if (m.startsWith("grok")) return "xai";
  return dialect === "anthropic" ? "anthropic" : "openai";
}

/** Forward to the real upstream with the real key. Streams straight through. */
async function forward(req, res, target, up, key, body, app) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (["host", "connection", "content-length", "authorization", "x-api-key", "xi-api-key", "x-goog-api-key"].includes(k)) continue;
    headers[k] = v;
  }
  up.inject(headers, key);
  const upstream = await fetch(target, { method: req.method, headers, body: body || undefined, duplex: body ? "half" : undefined });
  res.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([k]) => !["transfer-encoding", "content-encoding", "content-length", "connection"].includes(k))));
  if (upstream.body) {
    for await (const chunk of upstream.body) res.write(chunk);
  }
  res.end();
}

/** /v1/responses passthrough on the operator's ChatGPT subscription. */
async function subscriptionPassthrough(req, res, subscription) {
  if (!subscription.configured()) return json(res, 503, { error: { message: "ChatGPT subscription not configured (no Codex auth file)" } });
  const { token, accountId } = await subscription.accessToken();
  const body = (await readBody(req)).toString("utf8");
  const upstream = await fetch(SUBSCRIPTION_BACKEND, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`, "chatgpt-account-id": accountId,
      "content-type": "application/json", "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs", "user-agent": "floyd-vault-proxy/1.0 (codex_cli_rs compatible)",
    },
    body,
  });
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" });
  if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}

/** Minimal chat/completions -> subscription Responses translation (text). */
async function subscriptionChat(req, res, subscription, body) {
  if (!subscription.configured()) return json(res, 503, { error: { message: "ChatGPT subscription not configured (no Codex auth file)" } });
  const { token, accountId } = await subscription.accessToken();
  const system = (body.messages || []).filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
  const input = (body.messages || []).filter((m) => m.role !== "system").map((m) => ({
    type: "message", role: m.role,
    content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: textOf(m.content) }],
  }));
  const upstream = await fetch(SUBSCRIPTION_BACKEND, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`, "chatgpt-account-id": accountId,
      "content-type": "application/json", "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs", "user-agent": "floyd-vault-proxy/1.0 (codex_cli_rs compatible)",
    },
    body: JSON.stringify({ model: body.model, instructions: system || undefined, input, stream: true, store: false }),
  });
  if (!upstream.ok || !upstream.body) {
    const err = await upstream.text().catch(() => "");
    return json(res, upstream.status, { error: { message: `subscription backend HTTP ${upstream.status}: ${err.slice(0, 200)}` } });
  }
  const wantStream = Boolean(body.stream);
  const id = `chatcmpl-fv-${Date.now()}`;
  if (wantStream) res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  let full = "";
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let ev; try { ev = JSON.parse(payload); } catch { continue; }
      if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
        full += ev.delta;
        if (wantStream) {
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content: ev.delta }, finish_reason: null }] })}\n\n`);
        }
      }
    }
  }
  if (wantStream) {
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    return res.end();
  }
  return json(res, 200, { id, object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: full }, finish_reason: "stop" }] });
}

const textOf = (content) => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((c) => c.text ?? "").join("") : "";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("body too large"), { code: "BODY_TOO_LARGE" })); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
