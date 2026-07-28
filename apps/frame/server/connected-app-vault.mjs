import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ConnectedAppAuthorityError,
  ConnectedAppAuthorityService,
} from "./connected-app-authority.ts";
import {
  ConnectedAppTransport,
  ConnectedAppTransportError,
} from "./connected-app-transport.ts";

const CONNECTED_APP_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Vault-owned connected-application service.
 *
 * The database, encryption key, OAuth exchanges, refresh tokens, access
 * tokens, and authenticated MCP transport all remain inside the Frame/Vault
 * process. Its public dispatch boundary accepts only the already-authenticated
 * Core fv_ capability and returns browser-safe metadata or MCP messages.
 */
export class ConnectedAppVault {
  #db;
  #authority;
  #fetch;
  #returnUrl;
  #active = new Map();

  constructor({
    secretsDir,
    masterKey,
    returnUrl,
    fetchImpl = globalThis.fetch,
    evidence,
    now,
  }) {
    if (typeof secretsDir !== "string" || !secretsDir) {
      throw new TypeError("connected-app Vault requires its protected secrets directory");
    }
    if (!(masterKey instanceof Uint8Array) || masterKey.byteLength !== 32) {
      throw new TypeError("connected-app Vault requires its 32-byte Keychain master key");
    }
    this.#returnUrl = exactLoopbackReturnUrl(returnUrl);
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    const dbPath = join(secretsDir, "connected-apps.sqlite");
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    chmodSync(dbPath, 0o600);
    this.#fetch = fetchImpl;
    this.#authority = new ConnectedAppAuthorityService(this.#db, {
      masterKey,
      fetch: fetchImpl,
      evidence,
      now,
    });
  }

  async close() {
    const closing = [];
    for (const transports of this.#active.values()) {
      for (const transport of transports) closing.push(transport.close(AbortSignal.timeout(250)).catch(() => {}));
    }
    await Promise.all(closing);
    this.#active.clear();
    this.#db.close();
  }

  /**
   * OAuth providers redirect directly to this Vault-only callback. The
   * authorization code and one-time state are consumed here and never enter
   * Core. Only a sanitized application ID or error code reaches the UI.
   */
  async handleOAuthCallback({ state = "", code = "", error = "", signal }) {
    let location = new URL(this.#returnUrl);
    try {
      if (error) {
        throw new ConnectedAppAuthorityError(
          "oauth_authorization_denied",
          "connected app authorization was denied",
          400,
        );
      }
      const credentialRef = await this.#authority.completeOAuth(
        state,
        code,
        "vault-oauth-callback",
        signal,
      );
      location.searchParams.set(
        "connected_app",
        credentialRef.slice("floyd-connected-app:".length),
      );
    } catch (callbackError) {
      location.searchParams.set(
        "connection_error",
        callbackError instanceof ConnectedAppAuthorityError
          ? callbackError.code
          : "oauth_callback_failed",
      );
    }
    return Object.freeze({ status: 303, location: location.href });
  }

  async dispatch({ app, method, pathname, body = {}, signal }) {
    if (app !== "core") {
      return result(403, { error: "connected_app_scope_denied", message: "connected applications require Core's Vault capability" });
    }
    try {
      if (pathname === "/connected-apps" && method === "GET") {
        return result(200, { connectedApps: this.#authority.profiles() });
      }
      if (pathname === "/connected-apps" && method === "POST") {
        return result(201, await this.#authority.createProfile(objectBody(body), "core-vault-client", signal));
      }
      const match = pathname.match(/^\/connected-apps\/([^/]+)(?:\/(oauth\/start|refresh|invoke))?$/);
      if (!match) return result(404, { error: "connected_app_route_not_found" });
      const connectedAppId = decodeId(match[1]);
      const action = match[2] ?? "";
      if (action === "oauth/start" && method === "POST") {
        const input = objectBody(body);
        const ttlMs = input.ttlMs === undefined ? undefined : numberField(input.ttlMs, "OAuth ttl");
        return result(201, await this.#authority.beginOAuth(
          connectedAppId,
          stringField(input.callbackUrl, "OAuth callback URL"),
          ttlMs,
          "core-vault-client",
          signal,
        ));
      }
      if (action === "refresh" && method === "POST") {
        return result(200, await this.#authority.refreshNow(connectedAppId, signal));
      }
      if (action === "invoke" && method === "POST") {
        const input = objectBody(body);
        const rpcMethod = stringField(input.method, "connected app method");
        if (["initialize", "notifications/initialized"].includes(rpcMethod)) {
          throw new ConnectedAppTransportError(
            "mcp_method_invalid",
            "connected app invocation method is invalid",
            null,
          );
        }
        const credential = await this.#authority.resolve(`floyd-connected-app:${connectedAppId}`, signal);
        const transport = new ConnectedAppTransport(credential, { fetch: this.#fetch });
        const active = this.#active.get(connectedAppId) ?? new Set();
        active.add(transport);
        this.#active.set(connectedAppId, active);
        try {
          await transport.initialize({
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "Floyd Workstation", version: "0.1.0" },
          }, signal);
          const response = await transport.call(rpcMethod, input.params, signal);
          return result(200, {
            connectedAppId,
            status: response.status,
            messages: response.messages,
          });
        } finally {
          await transport.close(AbortSignal.timeout(2_000)).catch(() => {});
          active.delete(transport);
          if (!active.size) this.#active.delete(connectedAppId);
        }
      }
      if (!action && method === "DELETE") {
        const active = this.#active.get(connectedAppId);
        if (active) {
          await Promise.allSettled(Array.from(active, (transport) => transport.close(AbortSignal.timeout(500))));
          this.#active.delete(connectedAppId);
        }
        return result(200, await this.#authority.revoke(connectedAppId, "core-vault-client", signal));
      }
      return result(405, { error: "connected_app_method_not_allowed" });
    } catch (error) {
      if (error instanceof ConnectedAppAuthorityError) {
        return result(error.httpStatus, error.upstream ?? { error: error.code, message: error.message });
      }
      if (error instanceof ConnectedAppTransportError) {
        return result(error.upstreamStatus ?? 502, error.upstream ?? { error: error.code, message: error.message });
      }
      if (error instanceof ConnectedAppVaultInputError) {
        return result(400, { error: "invalid_input", message: error.message });
      }
      throw error;
    }
  }
}

export function createConnectedAppVault(options) {
  return new ConnectedAppVault(options);
}

function result(status, body) {
  return Object.freeze({ status, body });
}

function objectBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectedAppVaultInputError("request body must be a JSON object");
  }
  return value;
}

function stringField(value, label) {
  if (typeof value !== "string" || !value || value.length > 64 * 1024) {
    throw new ConnectedAppVaultInputError(`${label} is invalid`);
  }
  return value;
}

function numberField(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ConnectedAppVaultInputError(`${label} is invalid`);
  }
  return value;
}

function decodeId(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ConnectedAppVaultInputError("connected app id is invalid");
  }
  if (!CONNECTED_APP_ID.test(decoded)) {
    throw new ConnectedAppVaultInputError("connected app id is invalid");
  }
  return decoded;
}

class ConnectedAppVaultInputError extends Error {}

function exactLoopbackReturnUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError("connected-app Vault return URL is invalid");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    || url.username || url.password || url.hash) {
    throw new TypeError("connected-app Vault return URL must be an HTTP loopback URL");
  }
  return url.href;
}
