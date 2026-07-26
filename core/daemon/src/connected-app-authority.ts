import { constants, closeSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ConnectedAppProfile, ConnectedAppProfileInput, ConnectedAppOAuthStart } from "@floyd/contracts";
import type { Db } from "./db.ts";

const KEY_BYTES = 32;
const MAX_SECRET_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MIN_OAUTH_TTL_MS = 30_000;
const MAX_OAUTH_TTL_MS = 10 * 60_000;
const DEFAULT_OAUTH_TTL_MS = 5 * 60_000;
const REFRESH_SKEW_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 15_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS connected_app_profiles (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  resource_url TEXT NOT NULL,
  resource_metadata_url TEXT NOT NULL,
  authorization_server TEXT NOT NULL,
  authorization_url TEXT NOT NULL,
  token_url TEXT NOT NULL,
  registration_url TEXT,
  revocation_url TEXT,
  scopes_supported_json TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  client_id TEXT,
  client_secret_iv BLOB,
  client_secret_tag BLOB,
  client_secret_ciphertext BLOB,
  status TEXT NOT NULL CHECK(status IN ('discovered', 'authorization_required', 'connected', 'refreshing', 'reauth_required', 'revocation_pending', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS connected_app_credentials (
  credential_ref TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES connected_app_profiles(id),
  access_iv BLOB NOT NULL,
  access_tag BLOB NOT NULL,
  access_ciphertext BLOB NOT NULL,
  refresh_iv BLOB,
  refresh_tag BLOB,
  refresh_ciphertext BLOB,
  token_type TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at_ms INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  refresh_started_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connected_app_oauth_attempts (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES connected_app_profiles(id),
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

CREATE INDEX IF NOT EXISTS connected_app_credentials_connector
  ON connected_app_credentials(connector_id);
CREATE INDEX IF NOT EXISTS connected_app_attempts_expiry
  ON connected_app_oauth_attempts(expires_at_ms) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS connected_app_evidence_outbox (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

type ProfileRow = {
  id: string;
  display_name: string;
  resource_url: string;
  resource_metadata_url: string;
  authorization_server: string;
  authorization_url: string;
  token_url: string;
  registration_url: string | null;
  revocation_url: string | null;
  scopes_supported_json: string;
  scopes_json: string;
  client_id: string | null;
  client_secret_iv: Uint8Array | null;
  client_secret_tag: Uint8Array | null;
  client_secret_ciphertext: Uint8Array | null;
  status: ConnectedAppProfile["status"];
  revoked_at: string | null;
};

type CredentialRow = {
  credential_ref: string;
  connector_id: string;
  access_iv: Uint8Array;
  access_tag: Uint8Array;
  access_ciphertext: Uint8Array;
  refresh_iv: Uint8Array | null;
  refresh_tag: Uint8Array | null;
  refresh_ciphertext: Uint8Array | null;
  token_type: string;
  scopes_json: string;
  expires_at_ms: number | null;
  version: number;
  refresh_started_at: string | null;
};

type AttemptRow = {
  id: string;
  connector_id: string;
  state_hash: Uint8Array;
  verifier_iv: Uint8Array;
  verifier_tag: Uint8Array;
  verifier_ciphertext: Uint8Array;
  redirect_uri: string;
  expires_at_ms: number;
  exchange_started_at: string | null;
  consumed_at: string | null;
};

type OAuthMetadata = {
  resourceMetadataUrl: string;
  authorizationServer: string;
  authorizationUrl: string;
  tokenUrl: string;
  registrationUrl: string | null;
  revocationUrl: string | null;
  scopes: string[];
};

type TokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  expiresIn: number | null;
  scopes: string[] | null;
};

export type ConnectedAppAuthorityEvent = {
  type:
    | "connected_app.profile.created"
    | "connected_app.client.registered"
    | "connected_app.oauth.started"
    | "connected_app.oauth.completed"
    | "connected_app.credential.refreshed"
    | "connected_app.revoked";
  actor: string;
  payload: Readonly<Record<string, string | number | boolean | null>>;
};

export type ResolvedConnectedAppCredential = {
  credentialRef: string;
  connectorId: string;
  resourceUrl: string;
  authorization: string;
  expiresAt: string | null;
};

export class ConnectedAppAuthorityError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly upstream?: unknown;

  constructor(code: string, message: string, httpStatus: number, upstream?: unknown) {
    super(message);
    this.name = "ConnectedAppAuthorityError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.upstream = upstream;
  }
}

type Options = {
  masterKeyPath: string;
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  evidence?: (event: ConnectedAppAuthorityEvent) => void;
};

/**
 * Core-owned OAuth authority for connected applications such as remote MCP
 * servers. This is deliberately separate from model-provider API keys: an MCP
 * access token can never be selected as a /gateway model credential.
 */
export class ConnectedAppAuthorityService {
  readonly db: Db;
  readonly keyId: string;
  readonly #key: Buffer;
  readonly #now: () => number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #evidence?: (event: ConnectedAppAuthorityEvent) => void;
  readonly #refreshes = new Map<string, Promise<ResolvedConnectedAppCredential>>();

  constructor(db: Db, options: Options) {
    this.db = db;
    db.exec(SCHEMA);
    this.#key = loadOrCreateKey(options.masterKeyPath);
    this.keyId = createHash("sha256").update(this.#key).digest("hex").slice(0, 16);
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#evidence = options.evidence;
    this.flushEvidenceOutbox();
  }

  async createProfile(input: ConnectedAppProfileInput, actor = "core", signal?: AbortSignal): Promise<ConnectedAppProfile> {
    const id = validId(input.id, "connected app id");
    if (typeof input.displayName !== "string" || !input.displayName.trim() || input.displayName.length > 200) invalid("displayName is required");
    const resourceUrl = validExternalUrl(input.resourceUrl, "resourceUrl", true);
    const scopes = validScopes(input.scopes ?? []);
    if (this.db.prepare("SELECT 1 FROM connected_app_profiles WHERE id = ?").get(id)) invalid("connected app id already exists");
    const metadata = await this.#discover(resourceUrl, signal);
    const selectedScopes = scopes.length ? scopes : metadata.scopes;
    const now = new Date(this.#now()).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        `INSERT INTO connected_app_profiles
         (id, display_name, resource_url, resource_metadata_url, authorization_server, authorization_url,
          token_url, registration_url, revocation_url, scopes_supported_json, scopes_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?)`,
      ).run(id, input.displayName.trim(), resourceUrl, metadata.resourceMetadataUrl, metadata.authorizationServer,
        metadata.authorizationUrl, metadata.tokenUrl, metadata.registrationUrl,
        metadata.revocationUrl, JSON.stringify(metadata.scopes), JSON.stringify(selectedScopes), now, now);
      this.#emit("connected_app.profile.created", actor, {
        connector_id: id, resource_origin: new URL(resourceUrl).origin, dynamic_registration: Boolean(metadata.registrationUrl), key_id: this.keyId,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (String(error).includes("UNIQUE constraint failed")) invalid("connected app id already exists");
      throw error;
    }
    return this.profile(id)!;
  }

  profiles(): ConnectedAppProfile[] {
    const rows = this.db.prepare(
      `SELECT p.*, c.credential_ref, c.expires_at_ms, c.scopes_json AS credential_scopes_json
       FROM connected_app_profiles p LEFT JOIN connected_app_credentials c ON c.connector_id = p.id
       ORDER BY p.id`,
    ).all() as Array<ProfileRow & { credential_ref: string | null; expires_at_ms: number | null; credential_scopes_json: string | null }>;
    return rows.map(profileFromRow);
  }

  profile(idInput: string): ConnectedAppProfile | null {
    const id = validId(idInput, "connected app id");
    const row = this.db.prepare(
      `SELECT p.*, c.credential_ref, c.expires_at_ms, c.scopes_json AS credential_scopes_json
       FROM connected_app_profiles p LEFT JOIN connected_app_credentials c ON c.connector_id = p.id WHERE p.id = ?`,
    ).get(id) as unknown as (ProfileRow & { credential_ref: string | null; expires_at_ms: number | null; credential_scopes_json: string | null }) | undefined;
    return row ? profileFromRow(row) : null;
  }

  async beginOAuth(
    connectorIdInput: string,
    redirectUriInput: string,
    ttlMs = DEFAULT_OAUTH_TTL_MS,
    actor = "core",
    signal?: AbortSignal,
  ): Promise<ConnectedAppOAuthStart> {
    const connectorId = validId(connectorIdInput, "connected app id");
    const redirectUri = validRedirectUri(redirectUriInput);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_OAUTH_TTL_MS || ttlMs > MAX_OAUTH_TTL_MS) invalid("OAuth ttl is invalid");
    let profile = this.#profileRow(connectorId);
    if (!profile.client_id) {
      await this.#registerClient(profile, redirectUri, actor, signal);
      profile = this.#profileRow(connectorId);
    }
    const attemptId = routeId();
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const verifierBox = encrypt(this.#key, attemptAad(profile, attemptId), verifier);
    const nowMs = this.#now();
    const expiresAtMs = nowMs + ttlMs;
    const authorization = new URL(profile.authorization_url);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("client_id", profile.client_id!);
    authorization.searchParams.set("redirect_uri", redirectUri);
    authorization.searchParams.set("state", state);
    authorization.searchParams.set("code_challenge_method", "S256");
    authorization.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    authorization.searchParams.set("resource", resourceAudience(profile.resource_url));
    // Notion's documented custom-client flow requires an explicit consent
    // prompt. Other OAuth servers safely ignore the standard parameter.
    authorization.searchParams.set("prompt", "consent");
    const scopes = JSON.parse(profile.scopes_json) as string[];
    if (scopes.length) authorization.searchParams.set("scope", scopes.join(" "));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        `INSERT INTO connected_app_oauth_attempts
         (id, connector_id, state_hash, verifier_iv, verifier_tag, verifier_ciphertext,
          redirect_uri, created_at, expires_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(attemptId, connectorId, hash(state), verifierBox.iv, verifierBox.tag,
        verifierBox.ciphertext, redirectUri, new Date(nowMs).toISOString(), expiresAtMs);
      this.#emit("connected_app.oauth.started", actor, { connector_id: connectorId, attempt_id: attemptId, expires_at_ms: expiresAtMs });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.db.prepare("UPDATE connected_app_profiles SET status = 'authorization_required', updated_at = ? WHERE id = ?")
      .run(new Date(nowMs).toISOString(), connectorId);
    return { connectedAppId: connectorId, authorizationUrl: authorization.href, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  async completeOAuth(state: string, code: string, actor = "core", signal?: AbortSignal): Promise<string> {
    validSecret(state, "OAuth state");
    validSecret(code, "authorization code");
    const wanted = hash(state);
    const attempts = this.db.prepare("SELECT * FROM connected_app_oauth_attempts WHERE consumed_at IS NULL").all() as unknown as AttemptRow[];
    const attempt = attempts.find((candidate) => equalHash(candidate.state_hash, wanted));
    if (!attempt) throw new ConnectedAppAuthorityError("oauth_state_invalid", "connected app OAuth state is invalid", 401);
    if (this.#now() >= attempt.expires_at_ms) throw new ConnectedAppAuthorityError("oauth_state_expired", "connected app OAuth state has expired", 410);
    const exchangeStartedAt = new Date(this.#now()).toISOString();
    const staleBefore = new Date(this.#now() - UPSTREAM_TIMEOUT_MS * 2).toISOString();
    const claim = this.db.prepare(
      `UPDATE connected_app_oauth_attempts SET exchange_started_at = ?
       WHERE id = ? AND consumed_at IS NULL AND (exchange_started_at IS NULL OR exchange_started_at < ?)`,
    ).run(exchangeStartedAt, attempt.id, staleBefore);
    if (Number(claim.changes) !== 1) throw new ConnectedAppAuthorityError("oauth_state_in_use", "connected app OAuth exchange is already in progress", 409);
    const profile = this.#profileRow(attempt.connector_id);
    const verifier = decrypt(this.#key, attemptAad(profile, attempt.id), attempt.verifier_iv, attempt.verifier_tag, attempt.verifier_ciphertext);
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: attempt.redirect_uri,
      client_id: profile.client_id!,
      code_verifier: verifier,
      resource: resourceAudience(profile.resource_url),
    });
    this.#applyClientSecret(profile, form);
    let token: TokenResponse;
    try {
      token = await this.#tokenRequest(profile.token_url, form, signal);
    } catch (error) {
      this.db.prepare(
        "UPDATE connected_app_oauth_attempts SET exchange_started_at = NULL WHERE id = ? AND consumed_at IS NULL AND exchange_started_at = ?",
      ).run(attempt.id, exchangeStartedAt);
      throw error;
    }
    const credentialRef = `floyd-connected-app:${profile.id}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date(this.#now()).toISOString();
      const consumed = this.db.prepare(
        `UPDATE connected_app_oauth_attempts SET consumed_at = ?, exchange_started_at = NULL
         WHERE id = ? AND consumed_at IS NULL AND exchange_started_at = ?`,
      ).run(now, attempt.id, exchangeStartedAt);
      if (Number(consumed.changes) !== 1) throw new ConnectedAppAuthorityError("oauth_state_consumed", "connected app OAuth state was already consumed", 409);
      this.#writeCredential(credentialRef, profile.id, token, now);
      this.db.prepare("UPDATE connected_app_profiles SET revoked_at = NULL, status = 'connected', updated_at = ? WHERE id = ?").run(now, profile.id);
      this.#emitExternal("connected_app.oauth.completed", actor, { connector_id: profile.id, credential_ref: credentialRef });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.db.prepare(
        "UPDATE connected_app_oauth_attempts SET exchange_started_at = NULL WHERE id = ? AND consumed_at IS NULL AND exchange_started_at = ?",
      ).run(attempt.id, exchangeStartedAt);
      throw error;
    }
    return credentialRef;
  }

  async resolve(credentialRefInput: string, signal?: AbortSignal): Promise<ResolvedConnectedAppCredential> {
    const credentialRef = validCredentialRef(credentialRefInput);
    const current = this.#credentialWithProfile(credentialRef);
    if (current.credential.expires_at_ms !== null && current.credential.expires_at_ms <= this.#now() + REFRESH_SKEW_MS) {
      return this.#coalescedRefresh(credentialRef, current, signal);
    }
    return this.#resolved(current.profile, current.credential);
  }

  async refreshNow(connectorIdInput: string, signal?: AbortSignal): Promise<{ connectedAppId: string; expiresAt: string | null }> {
    const connectorId = validId(connectorIdInput, "connected app id");
    const credential = this.db.prepare("SELECT * FROM connected_app_credentials WHERE connector_id = ?").get(connectorId) as unknown as CredentialRow | undefined;
    if (!credential) throw new ConnectedAppAuthorityError("credential_not_found", "connected app is not authorized", 404);
    if (!credential.refresh_ciphertext) throw new ConnectedAppAuthorityError("refresh_unsupported", "connected app did not issue a refresh token", 400);
    const resolved = await this.#coalescedRefresh(credential.credential_ref, { profile: this.#profileRow(connectorId), credential }, signal, true);
    return { connectedAppId: connectorId, expiresAt: resolved.expiresAt };
  }

  async revoke(connectorIdInput: string, actor = "core", signal?: AbortSignal): Promise<{ connectedAppId: string; revoked: boolean; upstreamStatus: number | null }> {
    const connectorId = validId(connectorIdInput, "connected app id");
    const profile = this.#profileRow(connectorId);
    const credential = this.db.prepare("SELECT * FROM connected_app_credentials WHERE connector_id = ?").get(connectorId) as unknown as CredentialRow | undefined;
    if (!credential) return { connectedAppId: connectorId, revoked: false, upstreamStatus: null };
    let upstreamStatus: number | null = null;
    if (profile.revocation_url) {
      // Revoke a rotating refresh token before the short-lived access token.
      // Doing this sequentially prevents a concurrent refresh from minting a
      // replacement grant while disconnection is already under way.
      const values = [
        ...(credential.refresh_iv && credential.refresh_tag && credential.refresh_ciphertext
          ? [{ value: decrypt(this.#key, credentialAad(profile, "refresh"), credential.refresh_iv, credential.refresh_tag, credential.refresh_ciphertext), hint: "refresh_token" }]
          : []),
        { value: decrypt(this.#key, credentialAad(profile, "access"), credential.access_iv, credential.access_tag, credential.access_ciphertext), hint: "access_token" },
      ];
      const statuses: Array<number | null> = [];
      for (const token of values) {
        const form = new URLSearchParams({ token: token.value, token_type_hint: token.hint, client_id: profile.client_id! });
        this.#applyClientSecret(profile, form);
        try {
          const response = await this.#fetch(profile.revocation_url, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: form,
            signal: combinedSignal(signal),
            redirect: "error",
          });
          statuses.push(response.status);
          await response.body?.cancel().catch(() => {});
        } catch { statuses.push(null); }
      }
      const failed = statuses.find((status) => status !== null && (status < 200 || status >= 300));
      upstreamStatus = statuses.includes(null) ? null : failed ?? Math.max(...statuses as number[]);
    }
    const revokedAt = new Date(this.#now()).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM connected_app_credentials WHERE connector_id = ?").run(connectorId);
      const status = profile.revocation_url && (upstreamStatus === null || upstreamStatus < 200 || upstreamStatus >= 300)
        ? "revocation_pending"
        : "revoked";
      this.db.prepare("UPDATE connected_app_profiles SET revoked_at = ?, status = ?, updated_at = ? WHERE id = ?").run(revokedAt, status, revokedAt, connectorId);
      this.#emitExternal("connected_app.revoked", actor, { connector_id: connectorId, upstream_status: upstreamStatus });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { connectedAppId: connectorId, revoked: true, upstreamStatus };
  }

  async #discover(resourceUrl: string, signal?: AbortSignal): Promise<OAuthMetadata> {
    const resourceMetadataUrl = await this.#resourceMetadataUrl(resourceUrl, signal);
    const protectedResource = await this.#jsonRequest(resourceMetadataUrl.href, undefined, signal, "protected_resource_metadata");
    const advertisedResource = (protectedResource as Record<string, unknown>).resource;
    if (advertisedResource !== resourceUrl) {
      throw new ConnectedAppAuthorityError("oauth_resource_mismatch", "protected resource metadata does not match the connected app URL", 502);
    }
    const servers = (protectedResource as Record<string, unknown>).authorization_servers;
    if (!Array.isArray(servers) || !servers.length || typeof servers[0] !== "string") {
      throw new ConnectedAppAuthorityError("oauth_metadata_invalid", "protected resource metadata has no authorization server", 502);
    }
    const authorizationServer = validExternalUrl(servers[0], "authorization server", false);
    const oauthMetadataUrl = new URL("/.well-known/oauth-authorization-server", `${authorizationServer}/`).href;
    let metadata: Record<string, unknown>;
    try {
      metadata = await this.#jsonRequest(oauthMetadataUrl, undefined, signal, "authorization_server_metadata") as Record<string, unknown>;
    } catch (error) {
      if (!(error instanceof ConnectedAppAuthorityError) || error.httpStatus !== 404) throw error;
      const openIdMetadataUrl = new URL("/.well-known/openid-configuration", `${authorizationServer}/`).href;
      metadata = await this.#jsonRequest(openIdMetadataUrl, undefined, signal, "openid_configuration") as Record<string, unknown>;
    }
    if (metadata.issuer !== authorizationServer) {
      throw new ConnectedAppAuthorityError("oauth_issuer_mismatch", "authorization server metadata issuer does not match the advertised issuer", 502);
    }
    const authorizationUrl = validMetadataEndpoint(metadata.authorization_endpoint, "authorization endpoint");
    const tokenUrl = validMetadataEndpoint(metadata.token_endpoint, "token endpoint");
    const registrationUrl = metadata.registration_endpoint === undefined ? null : validMetadataEndpoint(metadata.registration_endpoint, "registration endpoint");
    const revocationUrl = metadata.revocation_endpoint === undefined ? null : validMetadataEndpoint(metadata.revocation_endpoint, "revocation endpoint");
    if (Array.isArray(metadata.code_challenge_methods_supported) && !metadata.code_challenge_methods_supported.includes("S256")) {
      throw new ConnectedAppAuthorityError("oauth_pkce_unsupported", "authorization server does not advertise S256 PKCE", 502);
    }
    const grants = metadata.grant_types_supported;
    if (Array.isArray(grants) && !grants.includes("authorization_code")) {
      throw new ConnectedAppAuthorityError("oauth_grant_unsupported", "authorization server does not support authorization_code", 502);
    }
    const clientAuthMethods = metadata.token_endpoint_auth_methods_supported;
    if (Array.isArray(clientAuthMethods) && !clientAuthMethods.includes("none") && registrationUrl) {
      throw new ConnectedAppAuthorityError("oauth_client_auth_unsupported", "authorization server does not permit public PKCE clients", 502);
    }
    const scopes = Array.isArray(metadata.scopes_supported)
      ? validScopes(metadata.scopes_supported.filter((value): value is string => typeof value === "string"))
      : [];
    return { resourceMetadataUrl: resourceMetadataUrl.href, authorizationServer, authorizationUrl, tokenUrl, registrationUrl, revocationUrl, scopes };
  }

  async #resourceMetadataUrl(resourceUrl: string, signal?: AbortSignal): Promise<URL> {
    let challenge: Response;
    try {
      challenge = await this.#fetch(resourceUrl, {
        method: "GET",
        headers: { accept: "application/json, text/event-stream" },
        redirect: "error",
        signal: combinedSignal(signal),
      });
    } catch (error) {
      throw new ConnectedAppAuthorityError(
        "oauth_discovery_unavailable",
        error instanceof Error && error.name === "TimeoutError" ? "protected resource challenge timed out" : "protected resource challenge failed",
        504,
      );
    }
    const authenticate = challenge.headers.get("www-authenticate") ?? "";
    await challenge.body?.cancel().catch(() => {});
    const match = authenticate.match(/(?:^|[,\s])resource_metadata="([^"]+)"/i);
    if (match?.[1]) return new URL(validExternalUrl(match[1], "resource metadata URL", true));
    const resource = new URL(resourceUrl);
    const suffix = resource.pathname === "/" ? "" : resource.pathname;
    return new URL(`/.well-known/oauth-protected-resource${suffix}`, resource.origin);
  }

  async #registerClient(profile: ProfileRow, redirectUri: string, actor: string, signal?: AbortSignal): Promise<void> {
    if (!profile.registration_url) throw new ConnectedAppAuthorityError("dynamic_registration_unsupported", "connected app requires a pre-registered OAuth client", 400);
    const registration = await this.#jsonRequest(profile.registration_url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "Floyd Workstation",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(JSON.parse(profile.scopes_json).length ? { scope: (JSON.parse(profile.scopes_json) as string[]).join(" ") } : {}),
      }),
    }, signal, "dynamic_client_registration") as Record<string, unknown>;
    if (typeof registration.client_id !== "string" || !registration.client_id || registration.client_id.length > 4096) {
      throw new ConnectedAppAuthorityError("oauth_registration_invalid", "dynamic client registration response lacks client_id", 502);
    }
    const clientSecret = typeof registration.client_secret === "string" && registration.client_secret
      ? encrypt(this.#key, clientSecretAad(profile), registration.client_secret)
      : null;
    const now = new Date(this.#now()).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(
        `UPDATE connected_app_profiles SET client_id = ?, client_secret_iv = ?, client_secret_tag = ?,
         client_secret_ciphertext = ?, updated_at = ? WHERE id = ? AND client_id IS NULL`,
      ).run(registration.client_id, clientSecret?.iv ?? null, clientSecret?.tag ?? null,
        clientSecret?.ciphertext ?? null, now, profile.id);
      if (Number(result.changes) !== 1) throw new ConnectedAppAuthorityError("oauth_client_race", "connected app client registration raced another request", 409);
      this.#emitExternal("connected_app.client.registered", actor, { connector_id: profile.id, client_secret: Boolean(clientSecret) });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async #coalescedRefresh(
    credentialRef: string,
    current: { profile: ProfileRow; credential: CredentialRow },
    signal?: AbortSignal,
    force = false,
  ): Promise<ResolvedConnectedAppCredential> {
    const existing = this.#refreshes.get(credentialRef);
    if (existing) return existing;
    const refresh = this.#refresh(credentialRef, current, signal, force).finally(() => this.#refreshes.delete(credentialRef));
    this.#refreshes.set(credentialRef, refresh);
    return refresh;
  }

  async #refresh(
    credentialRef: string,
    current: { profile: ProfileRow; credential: CredentialRow },
    signal?: AbortSignal,
    force = false,
  ): Promise<ResolvedConnectedAppCredential> {
    const { profile, credential } = current;
    if (!credential.refresh_iv || !credential.refresh_tag || !credential.refresh_ciphertext) {
      throw new ConnectedAppAuthorityError("refresh_unsupported", "connected app did not issue a refresh token", 400);
    }
    if (!force && credential.expires_at_ms !== null && credential.expires_at_ms > this.#now() + REFRESH_SKEW_MS) {
      return this.#resolved(profile, credential);
    }
    const claim = `${new Date(this.#now()).toISOString()}:${randomBytes(12).toString("base64url")}`;
    const staleBefore = new Date(this.#now() - UPSTREAM_TIMEOUT_MS * 2).toISOString();
    const claimed = this.db.prepare(
      `UPDATE connected_app_credentials SET refresh_started_at = ? WHERE credential_ref = ? AND version = ?
       AND (refresh_started_at IS NULL OR refresh_started_at < ?)`,
    ).run(claim, credentialRef, credential.version, staleBefore);
    if (Number(claimed.changes) !== 1) return this.#waitForRefresh(credentialRef, credential.version, signal);
    const refreshToken = decrypt(this.#key, credentialAad(profile, "refresh"), credential.refresh_iv, credential.refresh_tag, credential.refresh_ciphertext);
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: profile.client_id!,
      resource: resourceAudience(profile.resource_url),
    });
    this.#applyClientSecret(profile, form);
    let token: TokenResponse;
    try {
      token = await this.#tokenRequest(profile.token_url, form, signal);
    } catch (error) {
      this.db.prepare(
        "UPDATE connected_app_credentials SET refresh_started_at = NULL WHERE credential_ref = ? AND version = ? AND refresh_started_at = ?",
      ).run(credentialRef, credential.version, claim);
      if (error instanceof ConnectedAppAuthorityError && error.upstream && typeof error.upstream === "object"
        && (error.upstream as Record<string, unknown>).error === "invalid_grant") {
        const now = new Date(this.#now()).toISOString();
        this.db.prepare("DELETE FROM connected_app_credentials WHERE credential_ref = ?").run(credentialRef);
        this.db.prepare("UPDATE connected_app_profiles SET revoked_at = ?, status = 'reauth_required', updated_at = ? WHERE id = ?").run(now, now, profile.id);
      }
      throw error;
    }
    const now = new Date(this.#now()).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE connected_app_profiles SET status = 'refreshing', updated_at = ? WHERE id = ?").run(now, profile.id);
      const access = encrypt(this.#key, credentialAad(profile, "access"), token.accessToken);
      const nextRefresh = token.refreshToken ?? refreshToken;
      const refresh = encrypt(this.#key, credentialAad(profile, "refresh"), nextRefresh);
      const expiresAtMs = token.expiresIn === null ? null : this.#now() + token.expiresIn * 1000;
      const result = this.db.prepare(
        `UPDATE connected_app_credentials SET access_iv=?, access_tag=?, access_ciphertext=?,
         refresh_iv=?, refresh_tag=?, refresh_ciphertext=?, token_type=?, scopes_json=?, expires_at_ms=?,
         version=version+1, updated_at=?, refresh_started_at=NULL
         WHERE credential_ref=? AND version=? AND refresh_started_at=?`,
      ).run(access.iv, access.tag, access.ciphertext, refresh.iv, refresh.tag, refresh.ciphertext,
        token.tokenType, JSON.stringify(token.scopes ?? (JSON.parse(credential.scopes_json) as string[])), expiresAtMs,
        now, credentialRef, credential.version, claim);
      if (Number(result.changes) !== 1) throw new ConnectedAppAuthorityError("refresh_race", "connected app refresh result lost its claim", 409);
      this.db.prepare("UPDATE connected_app_profiles SET status = 'connected', updated_at = ? WHERE id = ?").run(now, profile.id);
      this.#emitExternal("connected_app.credential.refreshed", "core", { connector_id: profile.id, credential_ref: credentialRef });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.#resolved(this.#profileRow(profile.id), this.#credentialRow(credentialRef));
  }

  async #waitForRefresh(credentialRef: string, priorVersion: number, signal?: AbortSignal): Promise<ResolvedConnectedAppCredential> {
    const deadline = Date.now() + UPSTREAM_TIMEOUT_MS * 2;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new ConnectedAppAuthorityError("request_aborted", "connected app request was aborted", 499);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const credential = this.#credentialRow(credentialRef);
      if (credential.version !== priorVersion) return this.#resolved(this.#profileRow(credential.connector_id), credential);
      if (!credential.refresh_started_at) return this.#coalescedRefresh(credentialRef, { profile: this.#profileRow(credential.connector_id), credential }, signal, true);
    }
    throw new ConnectedAppAuthorityError("refresh_timeout", "connected app credential refresh did not complete", 504);
  }

  async #tokenRequest(url: string, form: URLSearchParams, signal?: AbortSignal): Promise<TokenResponse> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          "user-agent": "Floyd-Workstation/1.0",
        },
        body: form,
        signal: combinedSignal(signal),
        redirect: "error",
      });
    } catch (error) {
      throw new ConnectedAppAuthorityError(
        "oauth_upstream_unavailable",
        error instanceof Error && error.name === "TimeoutError" ? "connected app OAuth endpoint timed out" : "connected app OAuth endpoint request failed",
        504,
      );
    }
    const text = await limitedResponseText(response);
    let payload: unknown = text;
    try { payload = JSON.parse(text); } catch { /* exact upstream text retained */ }
    if (!response.ok) throw new ConnectedAppAuthorityError(
      "oauth_upstream_error",
      `connected app OAuth endpoint returned ${response.status}`,
      response.status,
      redactOAuthPayload(payload),
    );
    if (!payload || typeof payload !== "object") throw new ConnectedAppAuthorityError("oauth_response_invalid", "connected app OAuth response is not an object", 502);
    const data = payload as Record<string, unknown>;
    if (typeof data.access_token !== "string" || !data.access_token) throw new ConnectedAppAuthorityError("oauth_response_invalid", "connected app OAuth response lacks access_token", 502);
    validHeaderSecret(data.access_token, "OAuth access token", 502);
    const tokenType = typeof data.token_type === "string" && data.token_type ? data.token_type : "Bearer";
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(tokenType)) throw new ConnectedAppAuthorityError("oauth_response_invalid", "connected app OAuth response has invalid token_type", 502);
    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : null,
      tokenType,
      expiresIn: typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0 ? data.expires_in : null,
      scopes: typeof data.scope === "string" ? validScopes(data.scope.split(/\s+/).filter(Boolean)) : null,
    };
  }

  async #jsonRequest(url: string, init: RequestInit | undefined, signal: AbortSignal | undefined, context: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(url, { ...init, signal: combinedSignal(signal), redirect: "error" });
    } catch (error) {
      throw new ConnectedAppAuthorityError(
        "oauth_discovery_unavailable",
        error instanceof Error && error.name === "TimeoutError" ? `${context} timed out` : `${context} request failed`,
        504,
      );
    }
    const text = await limitedResponseText(response);
    let payload: unknown = text;
    try { payload = JSON.parse(text); } catch { /* preserved below */ }
    if (!response.ok) throw new ConnectedAppAuthorityError("oauth_discovery_error", `${context} returned ${response.status}`, response.status, payload);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ConnectedAppAuthorityError("oauth_metadata_invalid", `${context} did not return a JSON object`, 502);
    }
    return payload;
  }

  #writeCredential(credentialRef: string, connectorId: string, token: TokenResponse, now: string): void {
    const profile = this.#profileRow(connectorId);
    const access = encrypt(this.#key, credentialAad(profile, "access"), token.accessToken);
    const refresh = token.refreshToken ? encrypt(this.#key, credentialAad(profile, "refresh"), token.refreshToken) : null;
    const expiresAtMs = token.expiresIn === null ? null : this.#now() + token.expiresIn * 1000;
    this.db.prepare(
      `INSERT INTO connected_app_credentials
       (credential_ref, connector_id, access_iv, access_tag, access_ciphertext,
        refresh_iv, refresh_tag, refresh_ciphertext, token_type, scopes_json, expires_at_ms, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(credential_ref) DO UPDATE SET access_iv=excluded.access_iv,
        access_tag=excluded.access_tag, access_ciphertext=excluded.access_ciphertext,
        refresh_iv=excluded.refresh_iv, refresh_tag=excluded.refresh_tag,
        refresh_ciphertext=excluded.refresh_ciphertext, token_type=excluded.token_type, scopes_json=excluded.scopes_json,
        expires_at_ms=excluded.expires_at_ms, version=connected_app_credentials.version+1,
        refresh_started_at=NULL, updated_at=excluded.updated_at`,
    ).run(credentialRef, connectorId, access.iv, access.tag, access.ciphertext,
      refresh?.iv ?? null, refresh?.tag ?? null, refresh?.ciphertext ?? null,
      token.tokenType, JSON.stringify(token.scopes ?? (JSON.parse(profile.scopes_json) as string[])), expiresAtMs, now, now);
  }

  #applyClientSecret(profile: ProfileRow, form: URLSearchParams): void {
    if (!profile.client_secret_iv || !profile.client_secret_tag || !profile.client_secret_ciphertext) return;
    form.set("client_secret", decrypt(this.#key, clientSecretAad(profile),
      profile.client_secret_iv, profile.client_secret_tag, profile.client_secret_ciphertext));
  }

  #resolved(profile: ProfileRow, credential: CredentialRow): ResolvedConnectedAppCredential {
    const access = decrypt(this.#key, credentialAad(profile, "access"), credential.access_iv, credential.access_tag, credential.access_ciphertext);
    return {
      credentialRef: credential.credential_ref,
      connectorId: profile.id,
      resourceUrl: profile.resource_url,
      authorization: `${credential.token_type} ${access}`,
      expiresAt: credential.expires_at_ms === null ? null : new Date(credential.expires_at_ms).toISOString(),
    };
  }

  #profileRow(id: string): ProfileRow {
    const row = this.db.prepare("SELECT * FROM connected_app_profiles WHERE id = ?").get(id) as unknown as ProfileRow | undefined;
    if (!row) throw new ConnectedAppAuthorityError("connected_app_not_found", "connected app not found", 404);
    return row;
  }

  #credentialRow(ref: string): CredentialRow {
    const row = this.db.prepare("SELECT * FROM connected_app_credentials WHERE credential_ref = ?").get(ref) as unknown as CredentialRow | undefined;
    if (!row) throw new ConnectedAppAuthorityError("credential_not_found", "connected app credential not found", 404);
    return row;
  }

  #credentialWithProfile(ref: string): { profile: ProfileRow; credential: CredentialRow } {
    const credential = this.#credentialRow(ref);
    return { credential, profile: this.#profileRow(credential.connector_id) };
  }

  #emit(type: ConnectedAppAuthorityEvent["type"], actor: string, payload: ConnectedAppAuthorityEvent["payload"]): void {
    this.flushEvidenceOutbox();
    this.#evidence?.({ type, actor, payload });
  }

  #emitExternal(type: ConnectedAppAuthorityEvent["type"], actor: string, payload: ConnectedAppAuthorityEvent["payload"]): void {
    try { this.#emit(type, actor, payload); }
    catch {
      this.db.prepare(
        "INSERT INTO connected_app_evidence_outbox (id, event_type, actor, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(routeId(), type, actor, JSON.stringify(payload), new Date(this.#now()).toISOString());
    }
  }

  flushEvidenceOutbox(): number {
    if (!this.#evidence) return 0;
    const rows = this.db.prepare(
      "SELECT id, event_type, actor, payload_json FROM connected_app_evidence_outbox ORDER BY created_at, id",
    ).all() as Array<{ id: string; event_type: ConnectedAppAuthorityEvent["type"]; actor: string; payload_json: string }>;
    let flushed = 0;
    for (const row of rows) {
      try { this.#evidence({ type: row.event_type, actor: row.actor, payload: JSON.parse(row.payload_json) as ConnectedAppAuthorityEvent["payload"] }); }
      catch { break; }
      this.db.prepare("DELETE FROM connected_app_evidence_outbox WHERE id = ?").run(row.id);
      flushed += 1;
    }
    return flushed;
  }
}

function profileFromRow(row: ProfileRow & { credential_ref: string | null; expires_at_ms: number | null; credential_scopes_json: string | null }): ConnectedAppProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    resourceUrl: row.resource_url,
    resourceMetadataUrl: row.resource_metadata_url,
    issuer: row.authorization_server,
    authorizationUrl: row.authorization_url,
    tokenUrl: row.token_url,
    registrationUrl: row.registration_url,
    revocationUrl: row.revocation_url,
    scopesSupported: JSON.parse(row.scopes_supported_json) as string[],
    scopesRequested: JSON.parse(row.scopes_json) as string[],
    scopesGranted: row.credential_ref && row.credential_scopes_json ? JSON.parse(row.credential_scopes_json) as string[] : [],
    registrationMethod: "dynamic",
    clientAuthMethod: row.client_secret_ciphertext ? "client_secret_post" : "none",
    expiresAt: row.expires_at_ms === null ? null : new Date(row.expires_at_ms).toISOString(),
    status: row.status,
  };
}

function validId(value: string, field: string): string {
  if (typeof value !== "string" || !ID.test(value)) invalid(`${field} is invalid`);
  return value;
}

function validCredentialRef(value: string): string {
  if (typeof value !== "string" || !/^floyd-connected-app:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new ConnectedAppAuthorityError("credential_ref_invalid", "connected app credential reference is invalid", 400);
  }
  return value;
}

function validSecret(value: string, field: string): void {
  if (typeof value !== "string" || value.length < 8 || Buffer.byteLength(value) > MAX_SECRET_BYTES) invalid(`${field} is invalid`);
}

function validHeaderSecret(value: string, field: string, status = 400): void {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new ConnectedAppAuthorityError("secret_invalid", `${field} contains forbidden control characters`, status);
}

function validScopes(scopes: string[]): string[] {
  if (!Array.isArray(scopes) || scopes.length > 100) invalid("connected app scopes are invalid");
  return [...new Set(scopes.map((scope) => {
    if (typeof scope !== "string" || !/^[A-Za-z0-9._:/-]{1,200}$/.test(scope)) invalid("connected app scope is invalid");
    return scope;
  }))].sort();
}

function validExternalUrl(input: string, field: string, allowPath: boolean): string {
  if (typeof input !== "string") invalid(`${field} is not a valid URL`);
  let url: URL;
  try { url = new URL(input); } catch { invalid(`${field} is not a valid URL`); }
  if (url!.protocol !== "https:" || url!.username || url!.password || url!.search || url!.hash) invalid(`${field} must be an HTTPS URL without credentials, query, or fragment`);
  if (!allowPath && url!.pathname !== "/") invalid(`${field} must be an HTTPS origin`);
  if (isLocalHostname(url!.hostname)) invalid(`${field} must not target a local or private host`);
  url!.pathname = allowPath ? url!.pathname.replace(/\/+$/, "") || "/" : "/";
  return allowPath ? url!.href.replace(/\/$/, "") : url!.origin;
}

function validMetadataEndpoint(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ConnectedAppAuthorityError("oauth_metadata_invalid", `${field} is missing`, 502);
  try { return validExternalUrl(value, field, true); }
  catch (error) {
    if (error instanceof ConnectedAppAuthorityError) throw new ConnectedAppAuthorityError("oauth_metadata_invalid", error.message, 502);
    throw error;
  }
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0"
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || host === "[::1]" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
}

function validRedirectUri(input: string): string {
  if (typeof input !== "string") invalid("redirectUri is not a valid URL");
  let url: URL;
  try { url = new URL(input); } catch { invalid("redirectUri is not a valid URL"); }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url!.hostname);
  if ((!loopback && url!.protocol !== "https:") || (loopback && !["http:", "https:"].includes(url!.protocol))
    || url!.username || url!.password || url!.hash) invalid("redirectUri must use HTTPS or an HTTP loopback address without credentials or fragment");
  return url!.href;
}

function resourceAudience(resourceUrl: string): string { return resourceUrl; }

function credentialAad(profile: ProfileRow, kind: "access" | "refresh"): string {
  return `credential:${profile.id}:${profile.authorization_server}:${profile.resource_url}:${kind}`;
}

function attemptAad(profile: ProfileRow, attemptId: string): string {
  return `attempt:${profile.id}:${profile.authorization_server}:${profile.resource_url}:${attemptId}:verifier`;
}

function clientSecretAad(profile: ProfileRow): string {
  return `profile:${profile.id}:${profile.authorization_server}:${profile.resource_url}:client-secret`;
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
      if (bytes > MAX_METADATA_BYTES) throw new ConnectedAppAuthorityError("oauth_response_too_large", "connected app OAuth response exceeds 1 MiB", 502);
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

function routeId(): string {
  let id: string;
  do id = randomBytes(12).toString("base64url"); while (!ID.test(id));
  return id;
}

function redactOAuthPayload(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (Array.isArray(value)) return value.map((item) => redactOAuthPayload(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = /(?:access|refresh|id)?_?token|client_?secret|authorization_?code|code_verifier|^code$|^state$/i.test(key)
      ? "[redacted]"
      : redactOAuthPayload(item, depth + 1);
  }
  return output;
}

function hash(value: string): Buffer { return createHash("sha256").update(value, "utf8").digest(); }
function equalHash(leftValue: Uint8Array, rightValue: Uint8Array): boolean {
  const left = Buffer.from(leftValue); const right = Buffer.from(rightValue);
  return left.length === right.length && timingSafeEqual(left, right);
}

function encrypt(key: Uint8Array, aad: string, plaintext: string): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  if (typeof plaintext !== "string" || !plaintext || Buffer.byteLength(plaintext) > MAX_SECRET_BYTES) invalid("secret is invalid");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`floyd-connected-app:v1:${aad}`));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

function decrypt(key: Uint8Array, aad: string, iv: Uint8Array, tag: Uint8Array, ciphertext: Uint8Array): string {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(`floyd-connected-app:v1:${aad}`));
    decipher.setAuthTag(Buffer.from(tag));
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new ConnectedAppAuthorityError("credential_decryption_failed", "connected app credential authentication failed", 500);
  }
}

function loadOrCreateKey(path: string): Buffer {
  if (!isAbsolute(path) || path.includes("\0") || path.length > 4096) throw new ConnectedAppAuthorityError("master_key_invalid", "connected app key path is invalid", 500);
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
      throw new ConnectedAppAuthorityError("master_key_invalid", "connected app key must be an owned, singly-linked 0600 file", 500);
    }
    const key = readFileSync(fd);
    if (key.length !== KEY_BYTES) throw new ConnectedAppAuthorityError("master_key_invalid", "connected app key must be 32 bytes", 500);
    return key;
  } finally { if (fd !== undefined) closeSync(fd); }
}

function invalid(message: string): never { throw new ConnectedAppAuthorityError("invalid_input", message, 400); }
