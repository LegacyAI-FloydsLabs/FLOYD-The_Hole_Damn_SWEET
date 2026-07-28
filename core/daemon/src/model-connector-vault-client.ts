import type {
  ConnectorOAuthStart,
  ConnectorProfile,
  ConnectorProfileInput,
} from "@floyd/contracts";
import { readCoreVaultCapability, type CoreVaultCapability } from "./vault-capability.ts";

export type ConnectorIngressKey = Readonly<{
  keyId: string;
  algorithm: "RSA-OAEP-256";
  spki: string;
}>;

export type SealedConnectorSecret = Readonly<{
  keyId: string;
  wrappedKey: string;
  iv: string;
  ciphertext: string;
  tag: string;
}>;

export class ModelConnectorVaultClientError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly upstream?: unknown;
  constructor(code: string, message: string, httpStatus: number, upstream?: unknown) {
    super(message);
    this.name = "ModelConnectorVaultClientError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.upstream = upstream;
  }
}

type Options = { capability?: CoreVaultCapability; fetch?: typeof globalThis.fetch };

/** Credential-free Core relay to Vault's custom model-connector authority. */
export class ModelConnectorVaultClient {
  readonly #capability: CoreVaultCapability;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: Options = {}) {
    this.#capability = options.capability ?? readCoreVaultCapability();
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  ingressKey(signal?: AbortSignal): Promise<ConnectorIngressKey> {
    return this.#request("GET", "/connectors/ingress-key", undefined, signal);
  }

  profiles(signal?: AbortSignal): Promise<{ connectors: ConnectorProfile[] }> {
    return this.#request("GET", "/connectors", undefined, signal);
  }

  createProfile(
    input: Omit<ConnectorProfileInput, "clientSecret"> & { sealedClientSecret?: SealedConnectorSecret },
    signal?: AbortSignal,
  ): Promise<ConnectorProfile> {
    return this.#request("POST", "/connectors", input, signal);
  }

  storeApiKey(connectorId: string, sealedApiKey: SealedConnectorSecret, signal?: AbortSignal): Promise<{ credentialRef: string }> {
    return this.#request("POST", this.#path(connectorId, "api-key"), { sealedApiKey }, signal);
  }

  beginOAuth(connectorId: string, ttlMs?: number, signal?: AbortSignal): Promise<ConnectorOAuthStart> {
    return this.#request("POST", this.#path(connectorId, "oauth/start"), {
      callbackUrl: `${this.#capability.proxy}/connectors/oauth/callback`,
      ...(ttlMs === undefined ? {} : { ttlMs }),
    }, signal);
  }

  revoke(connectorId: string, signal?: AbortSignal): Promise<{ connectorId: string; revoked: boolean; upstreamStatus: number | null }> {
    return this.#request("DELETE", this.#path(connectorId), undefined, signal);
  }

  #path(id: string, action?: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
      throw new ModelConnectorVaultClientError("invalid_input", "connector id is invalid", 400);
    }
    return `/connectors/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;
  }

  async #request<T>(method: string, pathname: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.#fetch(`${this.#capability.proxy}${pathname}`, {
      method,
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.#capability.token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const record = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
      throw new ModelConnectorVaultClientError(
        typeof record.error === "string" ? record.error : "model_connector_vault_error",
        typeof record.message === "string" ? record.message : `Vault returned HTTP ${response.status}`,
        response.status,
        payload,
      );
    }
    return payload as T;
  }
}
