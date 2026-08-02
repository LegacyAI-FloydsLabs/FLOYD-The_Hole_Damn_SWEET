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
import https from "node:https";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { VAULT_PROVIDER_CATALOG, VAULT_PROVIDER_IDS } from "../../../lib/vault-provider-catalog.mjs";
import {
  createExactSecretRedactor,
  pipeRedactedBody,
  redactSecretText,
} from "./exact-secret-redactor.mjs";
import { VaultConnectionRegistry } from "./vault-connection-registry.mjs";

export const VAULT_PROXY_VERSION = "1.0.0";
const MAX_BODY = 25 * 1024 * 1024;

function injectCredential(auth, headers, key) {
  if (auth === "anthropic") {
    headers["x-api-key"] = key;
    if (!headers["anthropic-version"]) headers["anthropic-version"] = "2023-06-01";
  } else if (auth === "google") headers["x-goog-api-key"] = key;
  else if (auth === "elevenlabs") headers["xi-api-key"] = key;
  else if (auth === "fal") headers.authorization = `Key ${key}`;
  else {
    headers.authorization = `Bearer ${key}`;
    if (auth === "github" && !headers["user-agent"]) headers["user-agent"] = "floyd-vault-proxy";
  }
}

/** Server-only upstream map derived from the credential-free shared catalog. */
export const UPSTREAMS = Object.freeze(Object.fromEntries(
  Object.entries(VAULT_PROVIDER_CATALOG)
    .filter(([, provider]) => provider.upstream)
    .map(([id, provider]) => [id, Object.freeze({
      base: provider.upstream,
      openai: provider.openai,
      anthropic: provider.anthropic,
      inject: (headers, key) => injectCredential(provider.auth, headers, key),
    })]),
));

// ---- live model catalog broker ---------------------------------------------
// One normalized answer to "what models does provider X offer right now",
// fetched upstream with the vault key so apps never see it. Short in-memory
// cache; on failure the last good answer or the catalog's static fallback is
// served (clearly marked) instead of an error page.
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
const MODELS_FETCH_TIMEOUT_MS = 4_000;

function normalizeProviderModels(shape, payload) {
  const rows = shape === "google" ? payload?.models : payload?.data;
  if (!Array.isArray(rows)) return null;
  const models = rows.map((row) => {
    if (!row || typeof row !== "object") return null;
    const rawId = row.id ?? row.name;
    if (typeof rawId !== "string" || !rawId) return null;
    const id = shape === "google" ? rawId.replace(/^models\//, "") : rawId;
    const display = row.display_name ?? row.displayName;
    return { id, name: typeof display === "string" && display ? display : id };
  }).filter(Boolean);
  return models.length ? models : null;
}

function staticModelsPayload(providerId) {
  const provider = VAULT_PROVIDER_CATALOG[providerId];
  const models = (provider?.models || []).map((id) => ({ id, name: id }));
  return models.length
    ? { provider: providerId, source: "fallback", fetchedAt: null, models }
    : null;
}

// ---- ChatGPT subscription (sole OpenAI credential) -------------------------
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // Codex CLI public client id (not a secret)
const SUBSCRIPTION_BACKEND = "https://chatgpt.com/backend-api/codex/responses";

export class SubscriptionAuth {
  constructor(authFile, secureStore = null) {
    this.authFile = authFile || process.env.CHATGPT_AUTH_FILE || join(homedir(), ".codex", "auth.json");
    this.secureStore = secureStore;
    this.refreshing = null;
  }
  read() {
    if (!this.secureStore) {
      throw new Error("ChatGPT subscription is not stored in the Vault Keychain");
    }
    return this.secureStore.read();
  }
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
    this.secureStore.write(auth);
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
export class TokenStore {
  constructor(secretsDir, { onRevoke = () => 0 } = {}) {
    this.path = join(secretsDir, "proxy-tokens.json");
    this.alertPath = join(secretsDir, "proxy-alerts.log");
    this.secretsDir = secretsDir;
    this.onRevoke = onRevoke;
  }
  load() {
    try { return JSON.parse(readFileSync(this.path, "utf8")); } catch { return { tokens: [] }; }
  }
  save(db) {
    mkdirSync(this.secretsDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(db, null, 2), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
  /** Create (or rotate) the token for an app name. Plaintext returned ONCE. */
  issue(app) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(app)) throw new Error("app name must be alphanumeric/dash/underscore");
    const db = this.load();
    const revokedTokenIds = [];
    for (const t of db.tokens) if (t.app === app && !t.revoked) {
      t.revoked = true;
      t.revoked_at = new Date().toISOString();
      revokedTokenIds.push(t.id);
    }
    const plaintext = `fv_${app}_${randomBytes(24).toString("hex")}`;
    db.tokens.push({
      id: randomBytes(6).toString("hex"), app, hash: sha256(plaintext),
      created_at: new Date().toISOString(), last_used_at: null, use_count: 0, revoked: false,
    });
    this.save(db);
    this.lastTerminationCount = this.onRevoke(revokedTokenIds);
    return plaintext;
  }
  revoke(app) {
    const db = this.load();
    let n = 0;
    const revokedTokenIds = [];
    for (const t of db.tokens) if (t.app === app && !t.revoked) {
      t.revoked = true;
      t.revoked_at = new Date().toISOString();
      revokedTokenIds.push(t.id);
      n++;
    }
    this.save(db);
    // Drop any cached plaintext so a frame-managed app cannot resurrect it.
    const cache = this.#cache();
    if (cache[app]) { delete cache[app]; this.#saveCache(cache); }
    this.lastTerminationCount = this.onRevoke(revokedTokenIds);
    return n;
  }
  /** Atomic revoke-and-replace used by leak reports. */
  rotate(app, detail = {}) {
    const previous = this.load().tokens.filter((token) => token.app === app && !token.revoked);
    if (!previous.length) throw new Error(`no active Vault capability for ${app}`);
    const replacement = this.issue(app);
    const cache = this.#cache();
    cache[app] = replacement;
    this.#saveCache(cache);
    this.alert("compromise_rotated", {
      app,
      revoked_token_ids: previous.map((token) => token.id),
      ...safeAlertDetail(detail),
    });
    return {
      token: replacement,
      revokedCount: previous.length,
      revokedTokenIds: previous.map((token) => token.id),
      terminatedConnections: this.lastTerminationCount || 0,
    };
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
  recordRoute(app, provider, status) {
    if (status < 200 || status >= 300) return;
    const db = this.load();
    const token = db.tokens.find((entry) => entry.app === app && !entry.revoked);
    if (!token) return;
    token.routes ||= {};
    const route = token.routes[provider] || { success_count: 0, last_success_at: null };
    route.success_count += 1;
    route.last_success_at = new Date().toISOString();
    token.routes[provider] = route;
    this.save(db);
  }
  clearProviderRoutes(provider) {
    const db = this.load();
    let cleared = 0;
    for (const token of db.tokens) {
      if (!token.routes?.[provider]) continue;
      delete token.routes[provider];
      cleared += 1;
    }
    if (cleared) this.save(db);
    return cleared;
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
  activeCapabilities() {
    const cache = this.#cache();
    return Object.entries(cache).flatMap(([app, token]) => {
      const verdict = this.verifyWithoutUsage(token);
      return verdict?.token && !verdict.revoked ? [{ app, token, id: verdict.token.id }] : [];
    });
  }
  verifyWithoutUsage(plaintext) {
    if (typeof plaintext !== "string" || !plaintext.startsWith("fv_")) return null;
    const h = Buffer.from(sha256(plaintext), "hex");
    for (const token of this.load().tokens) {
      const stored = Buffer.from(token.hash, "hex");
      if (stored.length === h.length && timingSafeEqual(stored, h)) {
        return token.revoked ? { revoked: token } : { token };
      }
    }
    return null;
  }
}
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function safeAlertDetail(detail) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return {};
  return Object.fromEntries(Object.entries(detail)
    .filter(([key, value]) => ["source", "reason", "alertId"].includes(key)
      && ["string", "number", "boolean"].includes(typeof value)));
}

// ---- proxy server ----------------------------------------------------------
export function createVaultProxy({
  secretsDir,
  realKey,
  upstreams = UPSTREAMS,
  authFile,
  subscriptionStore,
  connectedApps = null,
  modelConnectors = null,
  mcpRouter = null,
  omfBroker = null,
  routeTarget = (_providerId, defaultTarget) => defaultTarget,
  port = 13031,
  host = "127.0.0.1",
  fetchImpl = globalThis.fetch,
  googleWebSocketBase = "https://generativelanguage.googleapis.com",
  websocketRequestImpl,
}) {
  const connections = new VaultConnectionRegistry();
  const store = new TokenStore(secretsDir, {
    onRevoke: (tokenIds) => connections.terminate(tokenIds),
  });
  const subscription = new SubscriptionAuth(authFile, subscriptionStore);
  const upgradedSockets = new Set();
  const modelsCache = new Map(); // provider -> { at, payload } — per proxy instance

  /** One provider's model catalog: live when reachable, cache/static otherwise.
   * Shared by the /models routes, the GLM fallback model picker, and the
   * frame catalog merge. `app` enables route telemetry when present. */
  async function resolveProviderModels(providerId, { app = null, signal = null } = {}) {
    const provider = VAULT_PROVIDER_CATALOG[providerId];
    if (!provider) return { status: 404, payload: { error: { message: `unknown provider ${providerId}` } } };
    if (!provider.modelsPath) {
      const fallback = staticModelsPayload(providerId);
      if (fallback) return { status: 200, payload: fallback };
      return { status: 404, payload: { error: { message: `provider ${providerId} has no model catalog` } } };
    }
    let key;
    try { key = realKey(providerId); } catch { key = null; }
    if (!key) return { status: 503, payload: { error: { message: `vault has no key for ${providerId}` } } };
    const up = upstreams[providerId];
    if (!up) return { status: 404, payload: { error: { message: `no model catalog route for provider ${providerId}` } } };
    const cached = modelsCache.get(providerId);
    if (cached && Date.now() - cached.at < MODELS_CACHE_TTL_MS) {
      return { status: 200, payload: { ...cached.payload, source: "cache" } };
    }
    try {
      const target = routeTarget(providerId, up.base + provider.modelsPath);
      const headers = {};
      up.inject(headers, key);
      const response = await fetchImpl(target, {
        headers,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS)])
          : AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`provider answered HTTP ${response.status}`);
      const models = normalizeProviderModels(provider.modelsShape, await response.json());
      if (!models) throw new Error("provider returned an unrecognized model list");
      const payload = { provider: providerId, source: "live", fetchedAt: new Date().toISOString(), models };
      modelsCache.set(providerId, { at: Date.now(), payload });
      if (app) store.recordRoute(app, `${providerId}:models`, 200);
      return { status: 200, payload };
    } catch {
      if (cached) return { status: 200, payload: { ...cached.payload, source: "cache" } };
      const fallback = staticModelsPayload(providerId);
      if (fallback) return { status: 200, payload: fallback };
      return { status: 502, payload: { error: { message: `could not fetch the ${providerId} model catalog` } } };
    }
  }

  // ---- GLM always-fallback (chat routes) -------------------------------------
  // D3: when the resolved provider has no vault key, or its upstream HARD-fails
  // (network error, timeout, or HTTP 5xx — never 4xx), retry the request ONCE
  // via zai when zai is keyed and was not the requested provider. The dialect
  // is unchanged, so the body only needs its model rewritten to zai's.
  // D5: once a response has started streaming to the app, there is no retry.

  /** zai's current model: first entry of the live model broker, else the
   * catalog's static zai model. */
  async function resolveFallbackModel(signal) {
    try {
      const { status, payload } = await resolveProviderModels("zai", { signal });
      if (status === 200 && payload.models?.length) return payload.models[0].id;
    } catch { /* fall through to the static catalog model */ }
    return VAULT_PROVIDER_CATALOG.zai?.models?.[0] || null;
  }

  /** Serves one chat request via zai on behalf of a failed provider. Stamps
   * the truthful-telemetry headers (D4) and records the ACTUAL route served. */
  async function chatViaZaiFallback(req, res, { dialect, body, app, originalProviderId, zaiKey, signal }) {
    const up = upstreams.zai;
    const route = up?.[dialect];
    if (!up || !route || !zaiKey) return false;
    const model = await resolveFallbackModel(signal);
    if (!model) return false;
    const target = routeTarget("zai", route);
    const fallbackBody = adjustProviderBody("zai", Buffer.from(JSON.stringify({ ...body, model })));
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (["host", "connection", "content-length", "authorization", "x-api-key", "xi-api-key", "x-goog-api-key"].includes(k)) continue;
      headers[k] = v;
    }
    up.inject(headers, zaiKey);
    const upstream = await fetchImpl(target, {
      method: req.method,
      headers,
      body: fallbackBody,
      duplex: "half",
      signal,
    });
    store.recordRoute(app, `zai:fallback-from-${originalProviderId}`, upstream.status);
    res.writeHead(upstream.status, {
      ...Object.fromEntries([...upstream.headers]
        .filter(([k]) => !["transfer-encoding", "content-encoding", "content-length", "connection"].includes(k))
        .map(([name, value]) => [name, redactSecretText(value, [zaiKey])])),
      "x-floyd-fallback": originalProviderId,
      "x-floyd-fallback-model": model,
    });
    await pipeRedactedBody(upstream.body, res, [zaiKey]);
    res.end();
    return true;
  }

  /** Chat forward with the GLM safety net. Hard failures before the first
   * byte retry once via zai; 4xx and 2xx responses pass through untouched. */
  async function forwardChat(req, res, { target, up, key, body, app, providerId, dialect, rawBody, zaiKey, fallbackReady, signal }) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (["host", "connection", "content-length", "authorization", "x-api-key", "xi-api-key", "x-goog-api-key"].includes(k)) continue;
      headers[k] = v;
    }
    up.inject(headers, key);
    let upstream;
    try {
      upstream = await fetchImpl(target, {
        method: req.method,
        headers,
        body: body || undefined,
        duplex: body ? "half" : undefined,
        signal,
      });
    } catch (error) {
      if (fallbackReady
        && await chatViaZaiFallback(req, res, { dialect, body: rawBody, app, originalProviderId: providerId, zaiKey, signal })) return;
      throw error;
    }
    if (upstream.status >= 500 && fallbackReady) {
      try { await upstream.body?.cancel?.(); } catch { /* best effort */ }
      if (await chatViaZaiFallback(req, res, { dialect, body: rawBody, app, originalProviderId: providerId, zaiKey, signal })) return;
      return json(res, upstream.status, { error: { message: `${providerId} upstream answered HTTP ${upstream.status} and the zai fallback is unavailable` } });
    }
    store.recordRoute(app, providerId, upstream.status);
    res.writeHead(upstream.status, Object.fromEntries([...upstream.headers]
      .filter(([k]) => !["transfer-encoding", "content-encoding", "content-length", "connection"].includes(k))
      .map(([name, value]) => [name, redactSecretText(value, [key])])));
    await pipeRedactedBody(upstream.body, res, [key]);
    res.end();
  }

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, "http://x");
      const path = requestUrl.pathname;
      if (req.method === "GET" && path === "/healthz") {
        return json(res, 200, { ok: true, version: VAULT_PROXY_VERSION, service: "floyd-vault-proxy" });
      }
      if (req.method === "GET" && path === "/connected-apps/oauth/callback") {
        if (!connectedApps) return json(res, 503, { error: { message: "Vault connected applications are unavailable." } });
        const callback = await connectedApps.handleOAuthCallback({
          state: requestUrl.searchParams.get("state") || "",
          code: requestUrl.searchParams.get("code") || "",
          error: requestUrl.searchParams.get("error") || "",
          signal: requestAbortSignal(req, res),
        });
        res.writeHead(callback.status, {
          location: callback.location,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        });
        return res.end();
      }
      if (req.method === "GET" && path === "/connectors/oauth/callback") {
        if (!modelConnectors) return json(res, 503, { error: { message: "Vault model connectors are unavailable." } });
        const callback = await modelConnectors.handleOAuthCallback({
          state: requestUrl.searchParams.get("state") || "",
          code: requestUrl.searchParams.get("code") || "",
          error: requestUrl.searchParams.get("error") || "",
          signal: requestAbortSignal(req, res),
        });
        res.writeHead(callback.status, {
          location: callback.location,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        });
        return res.end();
      }
      if (omfBroker?.isHealth(path, req.method)) return omfBroker.health(res);

      const requestBody = req.method === "GET" || req.method === "HEAD" ? null : await readBody(req);
      // authenticate the proxied token from whatever header style the SDK used
      const presented = presentedToken(req.headers, requestUrl, requestBody);
      const verdict = presented ? store.verify(presented) : null;
      if (!verdict || verdict.revoked) {
        store.alert(verdict?.revoked ? "revoked_token_used" : presented ? "unknown_token" : "missing_token", {
          path, app: verdict?.revoked?.app ?? null,
        });
        return json(res, 401, { error: { message: "Vault proxy: invalid or missing proxied token." } });
      }
      const app = verdict.token.app;
      const requestAbort = new AbortController();
      const releaseSocket = connections.track(verdict.token.id, req.socket);
      const releaseAbort = connections.track(verdict.token.id, requestAbort);
      res.once("finish", releaseSocket);
      res.once("finish", releaseAbort);

      if (req.method === "GET" && path === "/status") {
        const configuredProviders = Object.keys(upstreams)
          .filter((providerId) => {
            try { return Boolean(realKey(providerId)); } catch { return false; }
          })
          .sort();
        return json(res, 200, {
          ok: true,
          app,
          subscriptionConfigured: subscription.configured(),
          configuredProviders,
          authority: "floyd-vault-keychain",
        });
      }

      // Live model catalogs, keyed providers only. Choosers across the
      // ecosystem sync from these answers, so adding a vault key is all it
      // takes for a provider (and its real, current models) to show up.
      if (req.method === "GET" && (path === "/models" || path.startsWith("/models/"))) {
        const resolveOne = (providerId) => resolveProviderModels(providerId, { app, signal: requestAbort.signal });
        if (path === "/models") {
          const keyed = VAULT_PROVIDER_IDS.filter((id) => {
            const provider = VAULT_PROVIDER_CATALOG[id];
            if (!provider?.modelsPath) return false;
            try { return Boolean(realKey(id)); } catch { return false; }
          });
          const providers = {};
          await Promise.all(keyed.map(async (id) => {
            const { payload } = await resolveOne(id);
            providers[id] = payload;
          }));
          return json(res, 200, { providers, fetchedAt: new Date().toISOString() });
        }
        const providerId = decodeURIComponent(path.slice("/models/".length));
        const { status, payload } = await resolveOne(providerId);
        return json(res, status, payload);
      }

      if (path === "/connected-apps" || path.startsWith("/connected-apps/")) {
        if (!connectedApps) return json(res, 503, { error: { message: "Vault connected applications are unavailable." } });
        let body = {};
        try {
          body = requestBody?.length ? JSON.parse(requestBody.toString("utf8")) : {};
        } catch {
          return json(res, 400, { error: "invalid_input", message: "request body must be valid JSON" });
        }
        const output = await connectedApps.dispatch({
          app,
          method: req.method,
          pathname: path,
          body,
          signal: requestAbort.signal,
        });
        return json(res, output.status, output.body);
      }
      const connectorInvoke = path.match(/^\/connectors\/([^/]+)\/invoke(?:\/(?:(?:v1\/)?messages|chat\/completions))?$/);
      if (connectorInvoke) {
        if (!modelConnectors) return json(res, 503, { error: { message: "Vault model connectors are unavailable." } });
        if (req.method !== "POST") return json(res, 405, { error: "connector invocation is POST" });
        let payload;
        try {
          payload = JSON.parse(requestBody?.toString("utf8") || "{}");
        } catch {
          return json(res, 400, { error: "invalid_input", message: "request body must be valid JSON" });
        }
        const response = await modelConnectors.invoke({
          app,
          connectorId: decodeURIComponent(connectorInvoke[1]),
          payload,
          signal: requestAbort.signal,
        });
        return pipeFetchResponse(res, response);
      }
      if (path === "/connectors" || path.startsWith("/connectors/")) {
        if (!modelConnectors) return json(res, 503, { error: { message: "Vault model connectors are unavailable." } });
        let body = {};
        try {
          body = requestBody?.length ? JSON.parse(requestBody.toString("utf8")) : {};
        } catch {
          return json(res, 400, { error: "invalid_input", message: "request body must be valid JSON" });
        }
        const output = await modelConnectors.dispatch({
          app,
          method: req.method,
          pathname: path,
          body,
          signal: requestAbort.signal,
        });
        return json(res, output.status, output.body);
      }
      if (mcpRouter && await mcpRouter.handle({
        req,
        res,
        requestUrl,
        body: requestBody,
        app,
        signal: requestAbort.signal,
        recordRoute: (route, status) => store.recordRoute(app, route, status),
      })) return;
      if (omfBroker && await omfBroker.handle({
        req,
        res,
        requestUrl,
        body: requestBody,
        app,
        token: presented,
      })) return;

      if (path === "/v1/responses") {
        return await subscriptionPassthrough(req, res, subscription, sanitizeBody(requestBody), fetchImpl, (status) => store.recordRoute(app, "openai", status), requestAbort.signal);
      }
      if (path === "/v1/chat/completions" || path === "/v1/messages") {
        const dialect = path === "/v1/messages" ? "anthropic" : "openai";
        const body = JSON.parse(sanitizeBody(requestBody).toString("utf8") || "{}");
        // Bare model names (app pointed at us via a base-URL override) get a
        // provider inferred from the model family (glm->zai, claude->anthropic...).
        const [prefix, model] = splitModel(body.model);
        const providerId = prefix || inferProvider(model, dialect);
        if (providerId === "openai") {
          return await subscriptionChat(res, subscription, { ...body, model }, fetchImpl, (status) => store.recordRoute(app, "openai", status), requestAbort.signal);
        }
        const up = upstreams[providerId];
        const defaultTarget = up?.[dialect];
        if (!defaultTarget) return json(res, 400, { error: { message: `no ${dialect} route for provider ${providerId}` } });
        const target = routeTarget(providerId, defaultTarget);
        const key = realKey(providerId);
        // D3 GLM always-fallback: zai is the safety net for every chat route
        // when it is keyed and was not the requested provider.
        let zaiKey = null;
        try { zaiKey = realKey("zai"); } catch { zaiKey = null; }
        const fallbackReady = providerId !== "zai" && Boolean(zaiKey && upstreams.zai?.[dialect]);
        if (!key) {
          if (fallbackReady
            && await chatViaZaiFallback(req, res, { dialect, body, app, originalProviderId: providerId, zaiKey, signal: requestAbort.signal })) return;
          return json(res, 503, { error: { message: `vault has no key for ${providerId}` } });
        }
        return await forwardChat(req, res, {
          target,
          up,
          key,
          body: adjustProviderBody(providerId, Buffer.from(JSON.stringify({ ...body, model }))),
          app,
          providerId,
          dialect,
          rawBody: body,
          zaiKey,
          fallbackReady,
          signal: requestAbort.signal,
        });
      }
      const generic = path.match(/^\/p\/([a-z0-9-]+)(\/.*)?$/);
      if (generic) {
        const [, providerId, rest] = generic;
        const up = upstreams[providerId];
        if (!up) return json(res, 404, { error: { message: `unknown provider ${providerId}` } });
        const key = realKey(providerId);
        if (!key) return json(res, 503, { error: { message: `vault has no key for ${providerId}` } });
        const targetUrl = sanitizeUrlCredential(requestUrl);
        const target = routeTarget(providerId, up.base + (rest || "/")) + targetUrl.search;
        const body = adjustProviderBody(providerId, sanitizeBody(requestBody));
        return await forward(req, res, target, up, key, body, app, providerId, fetchImpl, store, requestAbort.signal);
      }
      return json(res, 404, { error: { message: "not found" } });
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: { message: String(err?.message ?? err).slice(0, 300) } });
      else res.destroy();
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const fail = (status, message) => {
      if (socket.destroyed) return;
      const body = JSON.stringify({ error: { message } });
      const response =
        `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 503 ? "Service Unavailable" : "Bad Gateway"}\r\n`
        + "Content-Type: application/json\r\n"
        + `Content-Length: ${Buffer.byteLength(body)}\r\n`
        + "Connection: close\r\n\r\n"
        + body;
      socket.end(response);
    };
    try {
      const requestUrl = new URL(req.url, "http://x");
      const match = requestUrl.pathname.match(
        /^\/p\/google(\/ws\/google\.ai\.generativelanguage\.(?:v1alpha|v1beta)\.GenerativeService\.BidiGenerateContent(?:Constrained)?)$/,
      );
      if (!match) return fail(404, "Vault proxy: unsupported WebSocket route.");
      const presented = presentedToken(req.headers, requestUrl, null);
      const verdict = presented ? store.verify(presented) : null;
      if (!verdict || verdict.revoked) {
        store.alert(verdict?.revoked ? "revoked_token_used" : presented ? "unknown_token" : "missing_token", {
          path: requestUrl.pathname,
          app: verdict?.revoked?.app ?? null,
        });
        return fail(401, "Vault proxy: invalid or missing proxied token.");
      }
      const key = realKey("google");
      if (!key) return fail(503, "vault has no key for google");

      const target = new URL(googleWebSocketBase);
      if (!["http:", "https:"].includes(target.protocol) || target.username || target.password
        || target.search || target.hash || target.pathname !== "/") {
        return fail(502, "Vault Google WebSocket target is invalid.");
      }
      const upstreamUrl = new URL(target);
      upstreamUrl.pathname = match[1];
      upstreamUrl.searchParams.set("key", key);
      const headers = {
        connection: "Upgrade",
        upgrade: "websocket",
        host: upstreamUrl.host,
        ...(req.headers["sec-websocket-key"] ? { "sec-websocket-key": req.headers["sec-websocket-key"] } : {}),
        ...(req.headers["sec-websocket-version"] ? { "sec-websocket-version": req.headers["sec-websocket-version"] } : {}),
        ...(req.headers["sec-websocket-protocol"] ? { "sec-websocket-protocol": req.headers["sec-websocket-protocol"] } : {}),
        ...(req.headers["sec-websocket-extensions"] ? { "sec-websocket-extensions": req.headers["sec-websocket-extensions"] } : {}),
        ...(req.headers.origin ? { origin: req.headers.origin } : {}),
      };
      const requestWebSocket = websocketRequestImpl
        || (upstreamUrl.protocol === "https:" ? https.request : http.request);
      const upstreamRequest = requestWebSocket(upstreamUrl, { method: "GET", headers });
      const releaseClient = connections.track(verdict.token.id, socket);
      const releasePending = connections.track(verdict.token.id, upstreamRequest);
      upstreamRequest.once("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
        releasePending();
        const allowedResponseHeaders = new Set([
          "connection", "upgrade", "sec-websocket-accept",
          "sec-websocket-protocol", "sec-websocket-extensions",
        ]);
        let handshake = "HTTP/1.1 101 Switching Protocols\r\n";
        for (const [name, value] of Object.entries(upstreamResponse.headers)) {
          if (!allowedResponseHeaders.has(name.toLowerCase()) || value === undefined) continue;
          handshake += `${name}: ${Array.isArray(value) ? value.join(", ") : value}\r\n`;
        }
        socket.write(`${handshake}\r\n`);
        if (head.length) upstreamSocket.write(head);
        if (upstreamHead.length) socket.write(upstreamHead);
        upgradedSockets.add(socket);
        upgradedSockets.add(upstreamSocket);
        const releaseUpstream = connections.track(verdict.token.id, upstreamSocket);
        socket.once("close", () => {
          releaseClient();
          releaseUpstream();
          upgradedSockets.delete(socket);
          if (!upstreamSocket.destroyed) upstreamSocket.destroy();
        });
        upstreamSocket.once("close", () => {
          releaseClient();
          releaseUpstream();
          upgradedSockets.delete(upstreamSocket);
          if (!socket.destroyed) socket.destroy();
        });
        socket.pipe(upstreamSocket);
        upstreamSocket.pipe(socket);
        store.recordRoute(verdict.token.app, "google", 200);
      });
      upstreamRequest.once("response", (response) => {
        response.resume();
        fail(response.statusCode || 502, "Google Live WebSocket upgrade was rejected.");
      });
      upstreamRequest.once("error", () => fail(502, "Google Live WebSocket connection failed."));
      upstreamRequest.end();
    } catch {
      fail(502, "Vault Google WebSocket routing failed.");
    }
  });

  return {
    server, store, subscription, connections,
    // Live model lists for the frame catalog merge: keyed providers only,
    // each marked "live" when the broker reached the provider (cache counts),
    // "fallback" when the static catalog list was served.
    liveProviderModels: async (providerIds = VAULT_PROVIDER_IDS) => {
      const out = {};
      await Promise.all(providerIds.map(async (providerId) => {
        let key = null;
        try { key = realKey(providerId); } catch { key = null; }
        if (!key) return;
        const { status, payload } = await resolveProviderModels(providerId);
        if (status !== 200 || !payload.models?.length) return;
        out[providerId] = {
          models: payload.models.map((model) => model.id),
          source: payload.source === "fallback" ? "fallback" : "live",
        };
      }));
      return out;
    },
    listen: () => new Promise((resolve) => server.listen(port, host, () => resolve(server.address()))),
    close: async () => {
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      for (const socket of upgradedSockets) socket.destroy();
      server.closeAllConnections?.();
      await closed;
      await connectedApps?.close?.();
      await modelConnectors?.close?.();
    },
  };
}

async function pipeFetchResponse(res, response) {
  res.writeHead(response.status, {
    "content-type": response.headers.get("content-type") || "application/json",
    ...(response.headers.get("cache-control") ? { "cache-control": response.headers.get("cache-control") } : {}),
    ...(response.headers.get("retry-after") ? { "retry-after": response.headers.get("retry-after") } : {}),
    ...(response.headers.get("request-id") ? { "request-id": response.headers.get("request-id") } : {}),
  });
  if (!response.body) return res.end();
  for await (const chunk of response.body) {
    if (!res.write(chunk)) await new Promise((resolve) => res.once("drain", resolve));
  }
  res.end();
}

/** Pull a candidate fv_ token out of any auth header an SDK might use. */
function presentedToken(headers, url, body) {
  const auth = headers.authorization || "";
  for (const c of [auth.replace(/^Bearer\s+/i, "").replace(/^Key\s+/i, ""), headers["x-api-key"], headers["xi-api-key"], headers["x-goog-api-key"]]) {
    if (typeof c === "string" && c.startsWith("fv_")) return c;
  }
  for (const name of CREDENTIAL_QUERY_FIELDS) {
    const candidate = url.searchParams.get(name);
    if (candidate?.startsWith("fv_")) return candidate;
  }
  const jsonBody = parseJsonBody(body);
  for (const name of CREDENTIAL_BODY_FIELDS) {
    const candidate = jsonBody?.[name];
    if (typeof candidate === "string" && candidate.startsWith("fv_")) return candidate;
  }
  return null;
}

const CREDENTIAL_QUERY_FIELDS = ["key", "api_key", "apiKey", "token"];
const CREDENTIAL_BODY_FIELDS = ["api_key", "apiKey", "token"];

function parseJsonBody(body) {
  if (!body?.length) return null;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sanitizeUrlCredential(url) {
  const clean = new URL(url);
  for (const name of CREDENTIAL_QUERY_FIELDS) {
    if (clean.searchParams.get(name)?.startsWith("fv_")) clean.searchParams.delete(name);
  }
  return clean;
}

function sanitizeBody(body) {
  const parsed = parseJsonBody(body);
  if (!parsed) return body;
  let changed = false;
  for (const name of CREDENTIAL_BODY_FIELDS) {
    if (typeof parsed[name] === "string" && parsed[name].startsWith("fv_")) {
      delete parsed[name];
      changed = true;
    }
  }
  return changed ? Buffer.from(JSON.stringify(parsed)) : body;
}

function adjustProviderBody(providerId, body) {
  if (providerId !== "moonshot") return body;
  const parsed = parseJsonBody(body);
  if (!parsed) return body;
  parsed.temperature = 1;
  return Buffer.from(JSON.stringify(parsed));
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

/** Additive catalog merge for /api/vault/catalog: providers with a live
 * broker answer get their models replaced and a source marker; everyone else
 * keeps the static list marked "fallback". Never drops existing fields. */
export function mergeLiveProviderModels(providers, live) {
  return providers.map((entry) => {
    const merged = live?.[entry.id];
    return merged
      ? { ...entry, models: merged.models, source: merged.source }
      : { ...entry, source: "fallback" };
  });
}

/** Forward to the real upstream with the real key. Streams straight through. */
async function forward(req, res, target, up, key, body, app, providerId, fetchImpl, store, signal) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (["host", "connection", "content-length", "authorization", "x-api-key", "xi-api-key", "x-goog-api-key"].includes(k)) continue;
    headers[k] = v;
  }
  up.inject(headers, key);
  const upstream = await fetchImpl(target, {
    method: req.method,
    headers,
    body: body || undefined,
    duplex: body ? "half" : undefined,
    signal,
  });
  store.recordRoute(app, providerId, upstream.status);
  res.writeHead(upstream.status, Object.fromEntries([...upstream.headers]
    .filter(([k]) => !["transfer-encoding", "content-encoding", "content-length", "connection"].includes(k))
    .map(([name, value]) => [name, redactSecretText(value, [key])])));
  await pipeRedactedBody(upstream.body, res, [key]);
  res.end();
}

/** /v1/responses passthrough on the operator's ChatGPT subscription. */
async function subscriptionPassthrough(req, res, subscription, body, fetchImpl, recordRoute, signal) {
  if (!subscription.configured()) return json(res, 503, { error: { message: "ChatGPT subscription not configured in the Vault Keychain" } });
  const { token, accountId } = await subscription.accessToken();
  const upstream = await fetchImpl(SUBSCRIPTION_BACKEND, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`, "chatgpt-account-id": accountId,
      "content-type": "application/json", "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs", "user-agent": "floyd-vault-proxy/1.0 (codex_cli_rs compatible)",
    },
    body: body?.toString("utf8") || "",
    signal,
  });
  recordRoute(upstream.status);
  res.writeHead(upstream.status, {
    "content-type": redactSecretText(
      upstream.headers.get("content-type") || "application/json",
      [token],
    ),
  });
  await pipeRedactedBody(upstream.body, res, [token]);
  res.end();
}

/** Minimal chat/completions -> subscription Responses translation (text). */
async function subscriptionChat(res, subscription, body, fetchImpl, recordRoute, signal) {
  if (!subscription.configured()) return json(res, 503, { error: { message: "ChatGPT subscription not configured in the Vault Keychain" } });
  const { token, accountId } = await subscription.accessToken();
  const system = (body.messages || []).filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
  const input = (body.messages || []).filter((m) => m.role !== "system").map((m) => ({
    type: "message", role: m.role,
    content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: textOf(m.content) }],
  }));
  const upstream = await fetchImpl(SUBSCRIPTION_BACKEND, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`, "chatgpt-account-id": accountId,
      "content-type": "application/json", "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs", "user-agent": "floyd-vault-proxy/1.0 (codex_cli_rs compatible)",
    },
    body: JSON.stringify({ model: body.model, instructions: system || undefined, input, stream: true, store: false }),
    signal,
  });
  recordRoute(upstream.status);
  if (!upstream.ok || !upstream.body) {
    const err = await upstream.text().catch(() => "");
    return json(res, upstream.status, {
      error: {
        message: `subscription backend HTTP ${upstream.status}: ${redactSecretText(err, [token]).slice(0, 200)}`,
      },
    });
  }
  const wantStream = Boolean(body.stream);
  const id = `chatcmpl-fv-${Date.now()}`;
  if (wantStream) res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  let full = "";
  let buffer = "";
  const decoder = new TextDecoder();
  const subscriptionRedactor = createExactSecretRedactor([token]);
  for await (const rawChunk of upstream.body) {
    const chunk = subscriptionRedactor.push(rawChunk);
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
  buffer += decoder.decode(subscriptionRedactor.flush(), { stream: false });
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

function requestAbortSignal(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new Error("Vault client disconnected"));
  };
  req.once("aborted", abort);
  req.once("error", abort);
  res.once("close", () => {
    if (!res.writableEnded) abort();
  });
  return controller.signal;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
