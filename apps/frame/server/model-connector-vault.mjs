import {
  constants as cryptoConstants,
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
} from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ConnectorAuthorityError,
  ConnectorAuthorityService,
} from "./model-connector-authority.ts";
import {
  createExactSecretRedactor,
  redactSecretText,
} from "./exact-secret-redactor.mjs";

const CONNECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_SECRET_BYTES = 64 * 1024;
const CONNECTOR_CALLERS = new Set(["core", "desktop"]);

/** Vault ownership boundary for custom model connectors. */
export class ModelConnectorVault {
  #db;
  #authority;
  #fetch;
  #returnUrl;
  #privateKey;
  #ingress;

  constructor({ secretsDir, masterKey, returnUrl, fetchImpl = globalThis.fetch, evidence, now }) {
    if (typeof secretsDir !== "string" || !secretsDir) throw new TypeError("model-connector Vault requires its protected secrets directory");
    if (!(masterKey instanceof Uint8Array) || masterKey.byteLength !== 32) {
      throw new TypeError("model-connector Vault requires its 32-byte Keychain master key");
    }
    this.#returnUrl = exactLoopbackReturnUrl(returnUrl);
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    const dbPath = join(secretsDir, "model-connectors.sqlite");
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    chmodSync(dbPath, 0o600);
    this.#fetch = fetchImpl;
    this.#authority = new ConnectorAuthorityService(this.#db, { masterKey, fetch: fetchImpl, evidence, now });
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });
    this.#privateKey = pair.privateKey;
    const spki = pair.publicKey.export({ type: "spki", format: "der" });
    this.#ingress = Object.freeze({
      keyId: createHash("sha256").update(spki).digest("hex").slice(0, 24),
      algorithm: "RSA-OAEP-256",
      spki: spki.toString("base64url"),
    });
  }

  close() {
    this.#db.close();
  }

  ingressKey(app) {
    return app === "core"
      ? { status: 200, body: this.#ingress }
      : denied();
  }

  async handleOAuthCallback({ state = "", code = "", error = "", signal }) {
    const location = new URL(this.#returnUrl);
    try {
      if (error) throw new ConnectorAuthorityError("oauth_authorization_denied", "connector authorization was denied", 400);
      const credentialRef = await this.#authority.completeOAuth(state, code, "vault-oauth-callback", signal);
      location.searchParams.set("connector", credentialRef.slice("floyd-connector:".length));
    } catch (callbackError) {
      location.searchParams.set(
        "connector_error",
        callbackError instanceof ConnectorAuthorityError ? callbackError.code : "oauth_callback_failed",
      );
    }
    return Object.freeze({ status: 303, location: location.href });
  }

  async dispatch({ app, method, pathname, body = {}, signal }) {
    if (app === "desktop" && pathname === "/connectors/catalog" && method === "GET") {
      return {
        status: 200,
        body: {
          connectors: this.#authority.profiles().map((profile) => ({
            id: profile.id,
            displayName: profile.displayName,
            dialect: profile.dialect,
            configured: Boolean(profile.credentialRef) && !profile.revoked,
          })),
        },
      };
    }
    if (app !== "core") return denied();
    try {
      if (pathname === "/connectors/ingress-key" && method === "GET") {
        return { status: 200, body: this.#ingress };
      }
      if (pathname === "/connectors" && method === "GET") {
        return { status: 200, body: { connectors: this.#authority.profiles() } };
      }
      if (pathname === "/connectors" && method === "POST") {
        const input = objectBody(body);
        if (Object.hasOwn(input, "clientSecret")) invalid("plaintext clientSecret is forbidden");
        const profile = {
          ...input,
          ...(input.sealedClientSecret === undefined
            ? {}
            : { clientSecret: this.#open(input.sealedClientSecret, "connector client secret") }),
        };
        delete profile.sealedClientSecret;
        return { status: 201, body: this.#authority.createProfile(profile, "core-vault-client") };
      }
      const match = pathname.match(/^\/connectors\/([^/]+)(?:\/(api-key|oauth\/start))?$/);
      if (!match) return { status: 404, body: { error: "connector_route_not_found" } };
      const connectorId = decodeId(match[1]);
      const action = match[2] ?? "";
      if (action === "api-key" && method === "POST") {
        const input = objectBody(body);
        if (Object.hasOwn(input, "apiKey")) invalid("plaintext apiKey is forbidden");
        const credentialRef = this.#authority.storeApiKey(
          connectorId,
          this.#open(input.sealedApiKey, "connector API key"),
          "core-vault-client",
        );
        return { status: 201, body: { credentialRef } };
      }
      if (action === "oauth/start" && method === "POST") {
        const input = objectBody(body);
        const ttlMs = input.ttlMs === undefined ? undefined : numberField(input.ttlMs, "OAuth ttl");
        return {
          status: 201,
          body: this.#authority.beginOAuth(
            connectorId,
            stringField(input.callbackUrl, "OAuth callback URL"),
            ttlMs,
            "core-vault-client",
          ),
        };
      }
      if (!action && method === "DELETE") {
        return { status: 200, body: await this.#authority.revoke(connectorId, "core-vault-client", signal) };
      }
      return { status: 405, body: { error: "connector_method_not_allowed" } };
    } catch (error) {
      if (error instanceof ConnectorAuthorityError) {
        return { status: error.httpStatus, body: error.upstream ?? { error: error.code, message: error.message } };
      }
      if (error instanceof ModelConnectorInputError) {
        return { status: 400, body: { error: "invalid_input", message: error.message } };
      }
      throw error;
    }
  }

  /**
   * Perform the authenticated outbound model request in Vault. Core supplies
   * only the connector ID and credential-free model payload.
   */
  async invoke({ app, connectorId, payload, signal }) {
    if (!CONNECTOR_CALLERS.has(app)) {
      return Response.json(denied().body, { status: 403 });
    }
    try {
      const credential = await this.#authority.resolve(`floyd-connector:${decodeId(connectorId)}`, signal);
      const endpoint = new URL(credential.baseUrl);
      endpoint.pathname = endpoint.pathname.replace(/\/+$/, "").replace(/\/(chat\/completions|messages)$/, "");
      endpoint.pathname += credential.dialect === "anthropic" ? "/messages" : "/chat/completions";
      const headers = {
        "content-type": "application/json",
        accept: payload?.stream === false ? "application/json" : "text/event-stream",
        ...(credential.authorization ? { authorization: credential.authorization } : {}),
        ...(credential.apiKey ? { "x-api-key": credential.apiKey } : {}),
        ...(credential.dialect === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}),
      };
      const response = await this.#fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        redirect: "error",
        signal,
      });
      return redactConnectorResponse(response, connectorSecrets(credential));
    } catch (error) {
      if (error instanceof ConnectorAuthorityError) {
        return Response.json(error.upstream ?? { error: error.code, message: error.message }, { status: error.httpStatus });
      }
      throw error;
    }
  }

  #open(envelope, label) {
    const input = objectBody(envelope);
    if (input.keyId !== this.#ingress.keyId
      || typeof input.wrappedKey !== "string"
      || typeof input.iv !== "string"
      || typeof input.ciphertext !== "string"
      || typeof input.tag !== "string") {
      invalid(`${label} envelope is invalid or expired`);
    }
    let plaintext;
    try {
      const dataKey = privateDecrypt({
        key: this.#privateKey,
        padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      }, Buffer.from(input.wrappedKey, "base64url"));
      const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(input.iv, "base64url"));
      decipher.setAuthTag(Buffer.from(input.tag, "base64url"));
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(input.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      invalid(`${label} envelope cannot be decrypted`);
    }
    if (!plaintext || Buffer.byteLength(plaintext) > MAX_SECRET_BYTES || /[\r\n\u0000]/.test(plaintext)) {
      invalid(`${label} is invalid`);
    }
    return plaintext;
  }
}

export function createModelConnectorVault(options) {
  return new ModelConnectorVault(options);
}

function denied() {
  return { status: 403, body: { error: "connector_scope_denied", message: "model connectors require Core's Vault capability" } };
}

function connectorSecrets(credential) {
  const values = [];
  if (credential.apiKey) values.push(credential.apiKey);
  if (credential.authorization) {
    values.push(credential.authorization);
    const separator = credential.authorization.indexOf(" ");
    if (separator >= 0) values.push(credential.authorization.slice(separator + 1));
  }
  return uniqueSecrets(values);
}

function redactConnectorResponse(response, secrets) {
  if (!secrets.length) return response;
  const headers = new Headers();
  for (const [name, value] of response.headers) {
    if (["content-length", "content-encoding", "content-md5", "etag"].includes(name.toLowerCase())) continue;
    headers.set(name, redactSecretText(value, secrets));
  }
  const body = response.body ? redactStream(response.body, secrets) : null;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function redactStream(stream, secrets) {
  const redactor = createExactSecretRedactor(secrets);
  return stream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      const output = redactor.push(chunk);
      if (output.byteLength) controller.enqueue(output);
    },
    flush(controller) {
      const output = redactor.flush();
      if (output.byteLength) controller.enqueue(output);
    },
  }));
}

function uniqueSecrets(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length >= 8))]
    .sort((left, right) => right.length - left.length);
}

function exactLoopbackReturnUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new TypeError("model-connector Vault return URL is invalid"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    || url.username || url.password || url.hash) {
    throw new TypeError("model-connector Vault return URL must be an HTTP loopback URL");
  }
  return url.href;
}

function objectBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("request body must be a JSON object");
  return { ...value };
}

function decodeId(value) {
  let id;
  try { id = decodeURIComponent(value); } catch { invalid("connector id is invalid"); }
  if (!CONNECTOR_ID.test(id)) invalid("connector id is invalid");
  return id;
}

function stringField(value, label) {
  if (typeof value !== "string" || !value) invalid(`${label} is invalid`);
  return value;
}

function numberField(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) invalid(`${label} is invalid`);
  return value;
}

function invalid(message) {
  throw new ModelConnectorInputError(message);
}

class ModelConnectorInputError extends Error {}
