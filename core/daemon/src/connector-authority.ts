import { constants, closeSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.ts";
import type { ProviderRoute } from "./provider-gateway.ts";

const KEY_BYTES = 32;
const MAX_SECRET_BYTES = 64 * 1024;
const MIN_OAUTH_TTL_MS = 30_000;
const MAX_OAUTH_TTL_MS = 10 * 60_000;
const DEFAULT_OAUTH_TTL_MS = 5 * 60_000;
const REFRESH_SKEW_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 15_000;
const MAX_UPSTREAM_BODY_BYTES = 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDERS = ["opencode-zen", "opencode-go", "openai", "anthropic"] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS connector_profiles (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  dialect TEXT NOT NULL CHECK(dialect IN ('openai', 'anthropic')),
  base_url TEXT NOT NULL,
  client_id TEXT,
  client_auth TEXT NOT NULL DEFAULT 'none' CHECK(client_auth IN ('none', 'client_secret_basic', 'client_secret_post')),
  client_secret_iv BLOB,
  client_secret_tag BLOB,
  client_secret_ciphertext BLOB,
  authorization_url TEXT,
  token_url TEXT,
  revocation_url TEXT,
  scopes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS connector_credentials (
  credential_ref TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES connector_profiles(id),
  kind TEXT NOT NULL CHECK(kind IN ('api_key', 'oauth')),
  access_iv BLOB NOT NULL,
  access_tag BLOB NOT NULL,
  access_ciphertext BLOB NOT NULL,
  refresh_iv BLOB,
  refresh_tag BLOB,
  refresh_ciphertext BLOB,
  token_type TEXT NOT NULL,
  expires_at_ms INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  refresh_started_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS connector_oauth_attempts (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES connector_profiles(id),
  state_hash BLOB NOT NULL UNIQUE,
  verifier_iv BLOB NOT NULL,
  verifier_tag BLOB NOT NULL,
  verifier_ciphertext BLOB NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  exchange_started_at TEXT,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS connector_credentials_connector
  ON connector_credentials(connector_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS connector_oauth_attempts_expiry
  ON connector_oauth_attempts(expires_at_ms) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS connector_evidence_outbox (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export type ConnectorProfileInput = {
  id: string;
  displayName: string;
  provider: ProviderRoute;
  baseUrl: string;
  clientId?: string;
  clientSecret?: string;
  clientAuth?: "none" | "client_secret_basic" | "client_secret_post";
  authorizationUrl?: string;
  tokenUrl?: string;
  revocationUrl?: string;
  scopes?: string[];
};

export type ConnectorProfile = {
  id: string;
  displayName: string;
  provider: Exclude<ProviderRoute, "auto">;
  dialect: "openai" | "anthropic";
  baseUrl: string;
  clientId: string | null;
  clientAuth: "none" | "client_secret_basic" | "client_secret_post";
  authorizationUrl: string | null;
  tokenUrl: string | null;
  revocationUrl: string | null;
  scopes: string[];
  credentialRef: string | null;
  credentialKind: "api_key" | "oauth" | null;
  expiresAt: string | null;
  revoked: boolean;
};

export type ResolvedConnectorCredential = {
  credentialRef: string;
  connectorId: string;
  provider: Exclude<ProviderRoute, "auto">;
  dialect: "openai" | "anthropic";
  baseUrl: string;
  authorization?: string;
  apiKey?: string;
  expiresAt: string | null;
};

export type ConnectorAuthorityEvent = {
  type: "connector.profile.created" | "connector.credential.stored" | "connector.oauth.started" | "connector.oauth.completed" | "connector.credential.refreshed" | "connector.revoked";
  actor: string;
  payload: Readonly<Record<string, string | number | boolean | null>>;
};

export class ConnectorAuthorityError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly upstream?: unknown;
  constructor(code: string, message: string, httpStatus: number, upstream?: unknown) {
    super(message);
    this.name = "ConnectorAuthorityError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.upstream = upstream;
  }
}

type ConnectorAuthorityOptions = {
  masterKeyPath: string;
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  evidence?: (event: ConnectorAuthorityEvent) => void;
};

type ProfileRow = {
  id: string;
  display_name: string;
  provider: Exclude<ProviderRoute, "auto">;
  dialect: "openai" | "anthropic";
  base_url: string;
  client_id: string | null;
  client_auth: "none" | "client_secret_basic" | "client_secret_post";
  client_secret_iv: Uint8Array | null;
  client_secret_tag: Uint8Array | null;
  client_secret_ciphertext: Uint8Array | null;
  authorization_url: string | null;
  token_url: string | null;
  revocation_url: string | null;
  scopes_json: string;
  revoked_at: string | null;
};

type CredentialRow = {
  credential_ref: string;
  connector_id: string;
  kind: "api_key" | "oauth";
  access_iv: Uint8Array;
  access_tag: Uint8Array;
  access_ciphertext: Uint8Array;
  refresh_iv: Uint8Array | null;
  refresh_tag: Uint8Array | null;
  refresh_ciphertext: Uint8Array | null;
  token_type: string;
  expires_at_ms: number | null;
  version: number;
  refresh_started_at: string | null;
  revoked_at: string | null;
};

type OAuthAttemptRow = {
  id: string;
  connector_id: string;
  state_hash: Uint8Array;
  verifier_iv: Uint8Array;
  verifier_tag: Uint8Array;
  verifier_ciphertext: Uint8Array;
  redirect_uri: string;
  expires_at_ms: number;
  consumed_at: string | null;
  exchange_started_at: string | null;
};

export class ConnectorAuthorityService {
  readonly db: Db;
  readonly keyId: string;
  readonly #key: Buffer;
  readonly #now: () => number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #evidence?: (event: ConnectorAuthorityEvent) => void;
  readonly #refreshes = new Map<string, Promise<ResolvedConnectorCredential>>();

  constructor(db: Db, options: ConnectorAuthorityOptions) {
    this.db = db;
    db.exec(SCHEMA);
    // Forward-compatible migration for databases created before exchange
    // claiming was added. SQLite has no IF NOT EXISTS for ADD COLUMN.
    try { db.exec("ALTER TABLE connector_oauth_attempts ADD COLUMN exchange_started_at TEXT"); } catch (error) {
      if (!String(error).includes("duplicate column name")) throw error;
    }
    try { db.exec("ALTER TABLE connector_credentials ADD COLUMN refresh_started_at TEXT"); } catch (error) {
      if (!String(error).includes("duplicate column name")) throw error;
    }
    this.#key = loadOrCreateKey(options.masterKeyPath);
    this.keyId = createHash("sha256").update(this.#key).digest("hex").slice(0, 16);
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#evidence = options.evidence;
    this.flushEvidenceOutbox();
  }

  createProfile(input: ConnectorProfileInput, actor = "core"): ConnectorProfile {
    const id = validId(input.id, "connector id");
    if (!PROVIDERS.includes(input.provider as typeof PROVIDERS[number])) invalid("connector provider is unsupported");
    if (typeof input.displayName !== "string" || !input.displayName.trim() || input.displayName.length > 200) invalid("displayName is required");
    if (input.clientId !== undefined && (typeof input.clientId !== "string" || !input.clientId || input.clientId.length > 1024)) invalid("clientId is invalid");
    if (input.clientSecret !== undefined) validSecret(input.clientSecret, "clientSecret");
    const provider = input.provider as Exclude<ProviderRoute, "auto">;
    const dialect = provider === "anthropic" ? "anthropic" : "openai";
    const baseUrl = validEndpoint(input.baseUrl, "baseUrl");
    const authorizationUrl = input.authorizationUrl ? validEndpoint(input.authorizationUrl, "authorizationUrl") : null;
    const tokenUrl = input.tokenUrl ? validEndpoint(input.tokenUrl, "tokenUrl") : null;
    const revocationUrl = input.revocationUrl ? validEndpoint(input.revocationUrl, "revocationUrl") : null;
    const clientAuth = input.clientAuth ?? "none";
    if (!["none", "client_secret_basic", "client_secret_post"].includes(clientAuth)) invalid("clientAuth is invalid");
    if ((authorizationUrl || tokenUrl) && (!authorizationUrl || !tokenUrl || !input.clientId)) invalid("OAuth connectors require authorizationUrl, tokenUrl, and clientId");
    if (clientAuth !== "none" && !input.clientSecret) invalid(`${clientAuth} requires clientSecret`);
    const scopes = validScopes(input.scopes ?? []);
    const now = new Date(this.#now()).toISOString();
    const secret = input.clientSecret ? encrypt(this.#key, `profile:${id}:client-secret`, input.clientSecret) : null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        `INSERT INTO connector_profiles
         (id, display_name, provider, dialect, base_url, client_id, client_auth,
          client_secret_iv, client_secret_tag, client_secret_ciphertext,
          authorization_url, token_url, revocation_url, scopes_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, input.displayName.trim(), provider, dialect, baseUrl, input.clientId ?? null, clientAuth,
        secret?.iv ?? null, secret?.tag ?? null, secret?.ciphertext ?? null,
        authorizationUrl, tokenUrl, revocationUrl, JSON.stringify(scopes), now, now);
      this.#emit("connector.profile.created", actor, { connector_id: id, provider, oauth: Boolean(tokenUrl), key_id: this.keyId });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (String(error).includes("UNIQUE constraint failed")) invalid("connector id already exists");
      throw error;
    }
    return this.profile(id)!;
  }

  profiles(): ConnectorProfile[] {
    const rows = this.db.prepare(
      `SELECT p.*, c.credential_ref, c.kind, c.expires_at_ms, c.revoked_at AS credential_revoked_at
       FROM connector_profiles p LEFT JOIN connector_credentials c ON c.connector_id = p.id
       ORDER BY p.id`,
    ).all() as Array<ProfileRow & { credential_ref: string | null; kind: "api_key" | "oauth" | null; expires_at_ms: number | null; credential_revoked_at: string | null }>;
    return rows.map(profileFromRow);
  }

  profile(idInput: string): ConnectorProfile | null {
    const id = validId(idInput, "connector id");
    const row = this.db.prepare(
      `SELECT p.*, c.credential_ref, c.kind, c.expires_at_ms, c.revoked_at AS credential_revoked_at
       FROM connector_profiles p LEFT JOIN connector_credentials c ON c.connector_id = p.id WHERE p.id = ?`,
    ).get(id) as unknown as (ProfileRow & { credential_ref: string | null; kind: "api_key" | "oauth" | null; expires_at_ms: number | null; credential_revoked_at: string | null }) | undefined;
    return row ? profileFromRow(row) : null;
  }

  storeApiKey(connectorIdInput: string, apiKey: string, actor = "core"): string {
    const connectorId = validId(connectorIdInput, "connector id");
    validSecret(apiKey, "api key");
    validHeaderSecret(apiKey, "api key");
    const profile = this.#profileRow(connectorId);
    if (profile.revoked_at) throw new ConnectorAuthorityError("connector_revoked", "connector is revoked", 410);
    const credentialRef = `floyd-connector:${connectorId}`;
    const encrypted = encrypt(this.#key, `${credentialRef}:access`, apiKey);
    const now = new Date(this.#now()).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        `INSERT INTO connector_credentials
         (credential_ref, connector_id, kind, access_iv, access_tag, access_ciphertext, token_type, created_at, updated_at)
         VALUES (?, ?, 'api_key', ?, ?, ?, 'Bearer', ?, ?)
         ON CONFLICT(credential_ref) DO UPDATE SET
           kind='api_key', access_iv=excluded.access_iv, access_tag=excluded.access_tag,
           access_ciphertext=excluded.access_ciphertext, refresh_iv=NULL, refresh_tag=NULL,
           refresh_ciphertext=NULL, token_type='Bearer', expires_at_ms=NULL,
           version=connector_credentials.version+1, updated_at=excluded.updated_at, revoked_at=NULL`,
      ).run(credentialRef, connectorId, encrypted.iv, encrypted.tag, encrypted.ciphertext, now, now);
      this.#emit("connector.credential.stored", actor, { connector_id: connectorId, credential_ref: credentialRef, kind: "api_key" });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return credentialRef;
  }

  beginOAuth(connectorIdInput: string, redirectUriInput: string, ttlMs = DEFAULT_OAUTH_TTL_MS, actor = "core"): { authorizationUrl: string; state: string; expiresAt: string } {
    const connectorId = validId(connectorIdInput, "connector id");
    const profile = this.#profileRow(connectorId);
    if (!profile.authorization_url || !profile.token_url || !profile.client_id) invalid("connector is not configured for OAuth");
    if (profile.revoked_at) throw new ConnectorAuthorityError("connector_revoked", "connector is revoked", 410);
    const redirectUri = validRedirectUri(redirectUriInput);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_OAUTH_TTL_MS || ttlMs > MAX_OAUTH_TTL_MS) invalid("OAuth ttl is invalid");
    const id = routeId();
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const verifierBox = encrypt(this.#key, `oauth:${id}:verifier`, verifier);
    const nowMs = this.#now();
    const createdAt = new Date(nowMs).toISOString();
    const expiresAtMs = nowMs + ttlMs;
    const url = new URL(profile.authorization_url);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", profile.client_id);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    if (JSON.parse(profile.scopes_json).length) url.searchParams.set("scope", JSON.parse(profile.scopes_json).join(" "));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        `INSERT INTO connector_oauth_attempts
         (id, connector_id, state_hash, verifier_iv, verifier_tag, verifier_ciphertext, redirect_uri, created_at, expires_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, connectorId, hash(state), verifierBox.iv, verifierBox.tag, verifierBox.ciphertext, redirectUri, createdAt, expiresAtMs);
      this.#emit("connector.oauth.started", actor, { connector_id: connectorId, attempt_id: id, expires_at_ms: expiresAtMs });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { authorizationUrl: url.href, state, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  async completeOAuth(state: string, code: string, actor = "core", signal?: AbortSignal): Promise<string> {
    validSecret(state, "OAuth state");
    validSecret(code, "authorization code");
    const stateHash = hash(state);
    const rows = this.db.prepare(`SELECT * FROM connector_oauth_attempts WHERE consumed_at IS NULL`).all() as unknown as OAuthAttemptRow[];
    const attempt = rows.find((row) => equalHash(row.state_hash, stateHash));
    if (!attempt) throw new ConnectorAuthorityError("oauth_state_invalid", "OAuth state is invalid", 401);
    if (this.#now() >= attempt.expires_at_ms) throw new ConnectorAuthorityError("oauth_state_expired", "OAuth state has expired", 410);
    const exchangeStartedAt = new Date(this.#now()).toISOString();
    const staleExchangeBefore = new Date(this.#now() - UPSTREAM_TIMEOUT_MS * 2).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const claim = this.db.prepare(
        `UPDATE connector_oauth_attempts SET exchange_started_at = ?
         WHERE id = ? AND consumed_at IS NULL
         AND (exchange_started_at IS NULL OR exchange_started_at < ?)`,
      ).run(exchangeStartedAt, attempt.id, staleExchangeBefore);
      if (Number(claim.changes) !== 1) throw new ConnectorAuthorityError("oauth_state_in_use", "OAuth state exchange is already in progress", 409);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const profile = this.#profileRow(attempt.connector_id);
    if (profile.revoked_at) {
      this.db.prepare(`UPDATE connector_oauth_attempts SET exchange_started_at = NULL WHERE id = ?`).run(attempt.id);
      throw new ConnectorAuthorityError("connector_revoked", "connector is revoked", 410);
    }
    const verifier = decrypt(this.#key, `oauth:${attempt.id}:verifier`, attempt.verifier_iv, attempt.verifier_tag, attempt.verifier_ciphertext);
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: attempt.redirect_uri,
      client_id: profile.client_id!,
      code_verifier: verifier,
    });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    this.#applyClientAuthentication(profile, headers, form);
    let token: TokenResponse;
    try {
      token = await this.#tokenRequest(profile.token_url!, headers, form, signal);
    } catch (error) {
      this.db.prepare(
        `UPDATE connector_oauth_attempts SET exchange_started_at = NULL
         WHERE id = ? AND consumed_at IS NULL AND exchange_started_at = ?`,
      ).run(attempt.id, exchangeStartedAt);
      throw error;
    }
    const credentialRef = `floyd-connector:${profile.id}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const consumedAt = new Date(this.#now()).toISOString();
      const consumed = this.db.prepare(
        `UPDATE connector_oauth_attempts SET consumed_at = ?, exchange_started_at = NULL
         WHERE id = ? AND consumed_at IS NULL AND exchange_started_at = ?`,
      ).run(consumedAt, attempt.id, exchangeStartedAt);
      if (Number(consumed.changes) !== 1) throw new ConnectorAuthorityError("oauth_state_consumed", "OAuth state was already consumed", 409);
      this.#writeOAuthCredential(credentialRef, profile.id, token, consumedAt);
      this.#emitExternal("connector.oauth.completed", actor, { connector_id: profile.id, credential_ref: credentialRef });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.db.prepare(
        `UPDATE connector_oauth_attempts SET exchange_started_at = NULL
         WHERE id = ? AND consumed_at IS NULL AND exchange_started_at = ?`,
      ).run(attempt.id, exchangeStartedAt);
      throw error;
    }
    return credentialRef;
  }

  async resolve(credentialRefInput: string, signal?: AbortSignal): Promise<ResolvedConnectorCredential> {
    const credentialRef = validCredentialRef(credentialRefInput);
    const referencedProfile = this.#profileRow(credentialRef.slice("floyd-connector:".length));
    if (referencedProfile.revoked_at) throw new ConnectorAuthorityError("credential_revoked", "connector credential is revoked", 410);
    const current = this.#credentialWithProfile(credentialRef);
    if (current.credential.revoked_at || current.profile.revoked_at) throw new ConnectorAuthorityError("credential_revoked", "connector credential is revoked", 410);
    if (current.credential.expires_at_ms !== null && current.credential.expires_at_ms <= this.#now() + REFRESH_SKEW_MS) {
      if (!current.credential.refresh_ciphertext) throw new ConnectorAuthorityError("credential_expired", "connector credential expired without a refresh token", 401);
      const existing = this.#refreshes.get(credentialRef);
      if (existing) return existing;
      const refresh = this.#refresh(credentialRef, current, signal).finally(() => this.#refreshes.delete(credentialRef));
      this.#refreshes.set(credentialRef, refresh);
      return refresh;
    }
    return this.#resolved(current.profile, current.credential);
  }

  async revoke(connectorIdInput: string, actor = "core", signal?: AbortSignal): Promise<{ connectorId: string; revoked: boolean; upstreamStatus: number | null }> {
    const connectorId = validId(connectorIdInput, "connector id");
    const profile = this.#profileRow(connectorId);
    const credential = this.db.prepare(`SELECT * FROM connector_credentials WHERE connector_id = ?`).get(connectorId) as unknown as CredentialRow | undefined;
    let upstreamStatus: number | null = null;
    if (profile.revocation_url && credential && !credential.revoked_at) {
      const access = decrypt(this.#key, `${credential.credential_ref}:access`, credential.access_iv, credential.access_tag, credential.access_ciphertext);
      const tokens = [{ value: access, hint: credential.kind === "oauth" ? "access_token" : "api_key" }];
      if (credential.refresh_ciphertext && credential.refresh_iv && credential.refresh_tag) {
        tokens.push({
          value: decrypt(this.#key, `${credential.credential_ref}:refresh`, credential.refresh_iv, credential.refresh_tag, credential.refresh_ciphertext),
          hint: "refresh_token",
        });
      }
      const statuses = await Promise.all(tokens.map(async (token) => {
        const form = new URLSearchParams({ token: token.value, token_type_hint: token.hint });
        const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
        this.#applyClientAuthentication(profile, headers, form);
        try {
          const response = await this.#fetch(profile.revocation_url!, {
            method: "POST", headers, body: form, signal: combinedSignal(signal),
          });
          await response.body?.cancel().catch(() => {});
          return response.status;
        } catch { return null; }
      }));
      const failedStatus = statuses.find((status) => status !== null && (status < 200 || status >= 300));
      upstreamStatus = statuses.includes(null)
        ? null
        : failedStatus ?? Math.max(...statuses as number[]);
    }
    const revokedAt = new Date(this.#now()).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`UPDATE connector_profiles SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL`).run(revokedAt, revokedAt, connectorId);
      // Revoked ciphertext has no operational value. Remove it instead of
      // retaining recoverable access/refresh secrets indefinitely.
      this.db.prepare(`DELETE FROM connector_credentials WHERE connector_id = ?`).run(connectorId);
      const revoked = Number(result.changes) === 1;
      if (revoked) this.#emitExternal("connector.revoked", actor, { connector_id: connectorId, upstream_status: upstreamStatus });
      this.db.exec("COMMIT");
      return { connectorId, revoked, upstreamStatus };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async #refresh(credentialRef: string, current: { profile: ProfileRow; credential: CredentialRow }, signal?: AbortSignal): Promise<ResolvedConnectorCredential> {
    const { profile, credential } = current;
    if (!profile.token_url) throw new ConnectorAuthorityError("refresh_unsupported", "connector has no token endpoint", 400);
    const claim = `${new Date(this.#now()).toISOString()}:${randomBytes(12).toString("base64url")}`;
    const staleBefore = new Date(this.#now() - UPSTREAM_TIMEOUT_MS * 2).toISOString();
    const claimed = this.db.prepare(
      `UPDATE connector_credentials SET refresh_started_at = ?
       WHERE credential_ref = ? AND version = ? AND revoked_at IS NULL
       AND (refresh_started_at IS NULL OR refresh_started_at < ?)`,
    ).run(claim, credentialRef, credential.version, staleBefore);
    if (Number(claimed.changes) !== 1) return this.#waitForRefresh(credentialRef, credential.version, signal);
    const refreshToken = decrypt(this.#key, `${credentialRef}:refresh`, credential.refresh_iv!, credential.refresh_tag!, credential.refresh_ciphertext!);
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: profile.client_id ?? "" });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    this.#applyClientAuthentication(profile, headers, form);
    let token: TokenResponse;
    try {
      token = await this.#tokenRequest(profile.token_url, headers, form, signal);
    } catch (error) {
      this.db.prepare(
        `UPDATE connector_credentials SET refresh_started_at = NULL
         WHERE credential_ref = ? AND version = ? AND refresh_started_at = ?`,
      ).run(credentialRef, credential.version, claim);
      throw error;
    }
    const now = new Date(this.#now()).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const access = encrypt(this.#key, `${credentialRef}:access`, token.accessToken);
      const nextRefresh = token.refreshToken ?? refreshToken;
      const refresh = encrypt(this.#key, `${credentialRef}:refresh`, nextRefresh);
      const expiresAtMs = token.expiresIn === null ? null : this.#now() + token.expiresIn * 1000;
      const result = this.db.prepare(
        `UPDATE connector_credentials SET access_iv=?, access_tag=?, access_ciphertext=?,
         refresh_iv=?, refresh_tag=?, refresh_ciphertext=?, token_type=?, expires_at_ms=?,
         version=version+1, updated_at=?, refresh_started_at=NULL
         WHERE credential_ref=? AND version=? AND revoked_at IS NULL AND refresh_started_at=?`,
      ).run(access.iv, access.tag, access.ciphertext, refresh.iv, refresh.tag, refresh.ciphertext,
        token.tokenType, expiresAtMs, now, credentialRef, credential.version, claim);
      if (Number(result.changes) === 1) this.#emitExternal("connector.credential.refreshed", "core", { connector_id: profile.id, credential_ref: credentialRef });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.db.prepare(
        `UPDATE connector_credentials SET refresh_started_at = NULL
         WHERE credential_ref = ? AND version = ? AND refresh_started_at = ?`,
      ).run(credentialRef, credential.version, claim);
      throw error;
    }
    return this.#resolved(this.#profileRow(profile.id), this.#credentialRow(credentialRef));
  }

  async #waitForRefresh(credentialRef: string, priorVersion: number, signal?: AbortSignal): Promise<ResolvedConnectorCredential> {
    const deadline = Date.now() + UPSTREAM_TIMEOUT_MS * 2;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new ConnectorAuthorityError("request_aborted", "connector request was aborted", 499);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const credential = this.#credentialRow(credentialRef);
      const profile = this.#profileRow(credential.connector_id);
      if (credential.revoked_at || profile.revoked_at) throw new ConnectorAuthorityError("credential_revoked", "connector credential is revoked", 410);
      if (credential.version !== priorVersion) return this.#resolved(profile, credential);
      if (!credential.refresh_started_at) return this.#refresh(credentialRef, { profile, credential }, signal);
    }
    throw new ConnectorAuthorityError("refresh_timeout", "connector credential refresh did not complete", 504);
  }

  #writeOAuthCredential(credentialRef: string, connectorId: string, token: TokenResponse, now: string): void {
    const access = encrypt(this.#key, `${credentialRef}:access`, token.accessToken);
    const refresh = token.refreshToken ? encrypt(this.#key, `${credentialRef}:refresh`, token.refreshToken) : null;
    const expiresAtMs = token.expiresIn === null ? null : this.#now() + token.expiresIn * 1000;
    this.db.prepare(
      `INSERT INTO connector_credentials
       (credential_ref, connector_id, kind, access_iv, access_tag, access_ciphertext,
        refresh_iv, refresh_tag, refresh_ciphertext, token_type, expires_at_ms, created_at, updated_at)
       VALUES (?, ?, 'oauth', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(credential_ref) DO UPDATE SET kind='oauth', access_iv=excluded.access_iv,
        access_tag=excluded.access_tag, access_ciphertext=excluded.access_ciphertext,
        refresh_iv=excluded.refresh_iv, refresh_tag=excluded.refresh_tag,
        refresh_ciphertext=excluded.refresh_ciphertext, token_type=excluded.token_type,
        expires_at_ms=excluded.expires_at_ms, version=connector_credentials.version+1,
        updated_at=excluded.updated_at, revoked_at=NULL`,
    ).run(credentialRef, connectorId, access.iv, access.tag, access.ciphertext,
      refresh?.iv ?? null, refresh?.tag ?? null, refresh?.ciphertext ?? null,
      token.tokenType, expiresAtMs, now, now);
  }

  async #tokenRequest(url: string, headers: Record<string, string>, form: URLSearchParams, signal?: AbortSignal): Promise<TokenResponse> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST", headers, body: form, signal: combinedSignal(signal),
      });
    } catch (error) {
      throw new ConnectorAuthorityError(
        "oauth_upstream_unavailable",
        error instanceof Error && error.name === "TimeoutError"
          ? "OAuth token endpoint timed out"
          : "OAuth token endpoint request failed",
        504,
      );
    }
    const text = await limitedResponseText(response);
    let payload: unknown = text;
    try { payload = JSON.parse(text); } catch { /* exact upstream text retained */ }
    if (!response.ok) throw new ConnectorAuthorityError("oauth_upstream_error", `OAuth token endpoint returned ${response.status}`, response.status, payload);
    if (!payload || typeof payload !== "object") throw new ConnectorAuthorityError("oauth_response_invalid", "OAuth token response is not an object", 502);
    const data = payload as Record<string, unknown>;
    if (typeof data.access_token !== "string" || !data.access_token) throw new ConnectorAuthorityError("oauth_response_invalid", "OAuth token response lacks access_token", 502);
    validHeaderSecret(data.access_token, "OAuth access token", 502);
    const tokenType = typeof data.token_type === "string" && data.token_type ? data.token_type : "Bearer";
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(tokenType)) {
      throw new ConnectorAuthorityError("oauth_response_invalid", "OAuth token response has an invalid token_type", 502);
    }
    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : null,
      tokenType,
      expiresIn: typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0 ? data.expires_in : null,
    };
  }

  #applyClientAuthentication(profile: ProfileRow, headers: Record<string, string>, form: URLSearchParams): void {
    if (profile.client_auth === "none") return;
    if (!profile.client_secret_iv || !profile.client_secret_tag || !profile.client_secret_ciphertext) {
      throw new ConnectorAuthorityError("client_secret_missing", "OAuth client secret is unavailable", 500);
    }
    const secret = decrypt(this.#key, `profile:${profile.id}:client-secret`, profile.client_secret_iv, profile.client_secret_tag, profile.client_secret_ciphertext);
    if (profile.client_auth === "client_secret_basic") {
      headers.authorization = `Basic ${Buffer.from(`${profile.client_id}:${secret}`).toString("base64")}`;
    } else {
      form.set("client_secret", secret);
    }
  }

  #resolved(profile: ProfileRow, credential: CredentialRow): ResolvedConnectorCredential {
    if (credential.revoked_at || profile.revoked_at) throw new ConnectorAuthorityError("credential_revoked", "connector credential is revoked", 410);
    const secret = decrypt(this.#key, `${credential.credential_ref}:access`, credential.access_iv, credential.access_tag, credential.access_ciphertext);
    return {
      credentialRef: credential.credential_ref,
      connectorId: profile.id,
      provider: profile.provider,
      dialect: profile.dialect,
      baseUrl: profile.base_url,
      ...(credential.kind === "api_key" && profile.dialect === "anthropic"
        ? { apiKey: secret }
        : { authorization: `${credential.token_type} ${secret}` }),
      expiresAt: credential.expires_at_ms === null ? null : new Date(credential.expires_at_ms).toISOString(),
    };
  }

  #profileRow(id: string): ProfileRow {
    const row = this.db.prepare(`SELECT * FROM connector_profiles WHERE id = ?`).get(id) as unknown as ProfileRow | undefined;
    if (!row) throw new ConnectorAuthorityError("connector_not_found", "connector not found", 404);
    return row;
  }

  #credentialRow(ref: string): CredentialRow {
    const row = this.db.prepare(`SELECT * FROM connector_credentials WHERE credential_ref = ?`).get(ref) as unknown as CredentialRow | undefined;
    if (!row) throw new ConnectorAuthorityError("credential_not_found", "connector credential not found", 404);
    return row;
  }

  #credentialWithProfile(ref: string): { profile: ProfileRow; credential: CredentialRow } {
    const credential = this.#credentialRow(ref);
    return { credential, profile: this.#profileRow(credential.connector_id) };
  }

  #emit(type: ConnectorAuthorityEvent["type"], actor: string, payload: ConnectorAuthorityEvent["payload"]): void {
    this.flushEvidenceOutbox();
    this.#evidence?.({ type, actor, payload });
  }

  /** Replay queued external-side-effect audit events when the sink recovers. */
  flushEvidenceOutbox(): number {
    if (!this.#evidence) return 0;
    const rows = this.db.prepare(
      `SELECT id, event_type, actor, payload_json FROM connector_evidence_outbox ORDER BY created_at, id`,
    ).all() as Array<{ id: string; event_type: ConnectorAuthorityEvent["type"]; actor: string; payload_json: string }>;
    let flushed = 0;
    for (const row of rows) {
      try {
        this.#evidence({ type: row.event_type, actor: row.actor, payload: JSON.parse(row.payload_json) as ConnectorAuthorityEvent["payload"] });
      } catch { break; }
      this.db.prepare(`DELETE FROM connector_evidence_outbox WHERE id = ?`).run(row.id);
      flushed += 1;
    }
    return flushed;
  }

  /**
   * External token operations cannot participate in SQLite atomicity. If the
   * main evidence sink fails after a provider has issued/revoked a token, keep
   * the safe credential mutation and durably queue the exact audit event for
   * reconciliation instead of rolling back into an orphaned-token state.
   */
  #emitExternal(type: ConnectorAuthorityEvent["type"], actor: string, payload: ConnectorAuthorityEvent["payload"]): void {
    try {
      this.#emit(type, actor, payload);
    } catch {
      this.db.prepare(
        `INSERT INTO connector_evidence_outbox (id, event_type, actor, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(routeId(), type, actor, JSON.stringify(payload), new Date(this.#now()).toISOString());
    }
  }
}

type TokenResponse = { accessToken: string; refreshToken: string | null; tokenType: string; expiresIn: number | null };

function profileFromRow(row: ProfileRow & { credential_ref: string | null; kind: "api_key" | "oauth" | null; expires_at_ms: number | null; credential_revoked_at: string | null }): ConnectorProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    provider: row.provider,
    dialect: row.dialect,
    baseUrl: row.base_url,
    clientId: row.client_id,
    clientAuth: row.client_auth,
    authorizationUrl: row.authorization_url,
    tokenUrl: row.token_url,
    revocationUrl: row.revocation_url,
    scopes: JSON.parse(row.scopes_json) as string[],
    credentialRef: row.credential_revoked_at ? null : row.credential_ref,
    credentialKind: row.credential_revoked_at ? null : row.kind,
    expiresAt: row.expires_at_ms === null ? null : new Date(row.expires_at_ms).toISOString(),
    revoked: Boolean(row.revoked_at),
  };
}

function validId(value: string, field: string): string {
  if (typeof value !== "string" || !ID.test(value)) invalid(`${field} is invalid`);
  return value;
}

function validCredentialRef(value: string): string {
  if (typeof value !== "string" || !/^floyd-connector:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new ConnectorAuthorityError("credential_ref_invalid", "connector credential reference is invalid", 400);
  }
  return value;
}

function validSecret(value: string, field: string): void {
  if (typeof value !== "string" || value.length < 8 || Buffer.byteLength(value) > MAX_SECRET_BYTES) invalid(`${field} is invalid`);
}

function validHeaderSecret(value: string, field: string, status = 400): void {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new ConnectorAuthorityError("secret_invalid", `${field} contains forbidden control characters`, status);
  }
}

function combinedSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function limitedResponseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_UPSTREAM_BODY_BYTES) {
        throw new ConnectorAuthorityError("oauth_response_too_large", "OAuth endpoint response exceeds 1 MiB", 502);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(output);
}

function validScopes(scopes: string[]): string[] {
  if (!Array.isArray(scopes) || scopes.length > 100) invalid("connector scopes are invalid");
  return [...new Set(scopes.map((scope) => {
    if (typeof scope !== "string" || !/^[A-Za-z0-9._:/-]{1,200}$/.test(scope)) invalid("connector scope is invalid");
    return scope;
  }))].sort();
}

function validEndpoint(input: string, field: string): string {
  if (typeof input !== "string") invalid(`${field} is not a valid URL`);
  let url: URL;
  try { url = new URL(input); } catch { invalid(`${field} is not a valid URL`); }
  if (url!.username || url!.password || url!.hash || url!.search) invalid(`${field} must not contain credentials, query, or fragment`);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url!.hostname);
  if (url!.protocol !== "https:" && !(url!.protocol === "http:" && loopback)) invalid(`${field} must use HTTPS except for loopback tests`);
  url!.pathname = url!.pathname.replace(/\/+$/, "");
  return url!.href.replace(/\/$/, "");
}

function validRedirectUri(input: string): string {
  const url = validEndpoint(input, "redirectUri");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) invalid("redirectUri must use HTTPS or loopback");
  return url;
}

function routeId(): string {
  let id: string;
  do id = randomBytes(12).toString("base64url"); while (!ID.test(id));
  return id;
}

function hash(value: string): Buffer { return createHash("sha256").update(value, "utf8").digest(); }
function equalHash(a: Uint8Array, b: Uint8Array): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function encrypt(key: Uint8Array, aad: string, plaintext: string): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  validSecret(plaintext, "secret");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`floyd-connector:v1:${aad}`));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

function decrypt(key: Uint8Array, aad: string, iv: Uint8Array, tag: Uint8Array, ciphertext: Uint8Array): string {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(`floyd-connector:v1:${aad}`));
    decipher.setAuthTag(Buffer.from(tag));
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new ConnectorAuthorityError("credential_decryption_failed", "connector credential authentication failed", 500);
  }
}

function loadOrCreateKey(path: string): Buffer {
  if (!isAbsolute(path) || path.includes("\0") || path.length > 4096) throw new ConnectorAuthorityError("master_key_invalid", "connector key path is invalid", 500);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let created: number | undefined;
  try {
    created = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeSync(created, randomBytes(KEY_BYTES));
    fchmodSync(created, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally { if (created !== undefined) closeSync(created); }
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new ConnectorAuthorityError("master_key_invalid", "connector key must be an owned, singly-linked 0600 file", 500);
    }
    const key = readFileSync(fd);
    if (key.length !== KEY_BYTES) throw new ConnectorAuthorityError("master_key_invalid", "connector key must be 32 bytes", 500);
    return key;
  } finally { if (fd !== undefined) closeSync(fd); }
}

function invalid(message: string): never { throw new ConnectorAuthorityError("invalid_input", message, 400); }
