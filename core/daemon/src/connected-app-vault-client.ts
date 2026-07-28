import type {
  ConnectedAppInvokeRequest,
  ConnectedAppInvokeResponse,
  ConnectedAppOAuthStart,
  ConnectedAppProfile,
  ConnectedAppProfileInput,
} from "@floyd/contracts";
import { readCoreVaultCapability, type CoreVaultCapability } from "./vault-capability.ts";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class ConnectedAppVaultClientError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly upstream?: unknown;

  constructor(code: string, message: string, httpStatus: number, upstream?: unknown) {
    super(message);
    this.name = "ConnectedAppVaultClientError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.upstream = upstream;
  }
}

type Options = {
  capability?: CoreVaultCapability;
  fetch?: typeof globalThis.fetch;
};

/**
 * Core's entire connected-application boundary.
 *
 * This client has only Core's persistent fv_ capability and the loopback Vault
 * address. OAuth secrets and authenticated transport never enter Core memory,
 * Core SQLite, an application response, or a child process.
 */
export class ConnectedAppVaultClient {
  readonly #capability: CoreVaultCapability;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: Options) {
    this.#capability = options.capability ?? readCoreVaultCapability();
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  profiles(signal?: AbortSignal): Promise<{ connectedApps: ConnectedAppProfile[] }> {
    return this.#request("GET", "/connected-apps", undefined, signal);
  }

  createProfile(input: ConnectedAppProfileInput, signal?: AbortSignal): Promise<ConnectedAppProfile> {
    return this.#request("POST", "/connected-apps", input, signal);
  }

  beginOAuth(connectedAppId: string, ttlMs?: number, signal?: AbortSignal): Promise<ConnectedAppOAuthStart> {
    return this.#request("POST", this.#path(connectedAppId, "oauth/start"), {
      ...(ttlMs === undefined ? {} : { ttlMs }),
      callbackUrl: `${this.#capability.proxy}/connected-apps/oauth/callback`,
    }, signal);
  }

  refreshNow(connectedAppId: string, signal?: AbortSignal): Promise<{ connectedAppId: string; expiresAt: string | null }> {
    return this.#request("POST", this.#path(connectedAppId, "refresh"), {}, signal);
  }

  invoke(connectedAppId: string, request: ConnectedAppInvokeRequest, signal?: AbortSignal): Promise<ConnectedAppInvokeResponse> {
    return this.#request("POST", this.#path(connectedAppId, "invoke"), request, signal);
  }

  revoke(connectedAppId: string, signal?: AbortSignal): Promise<{ connectedAppId: string; revoked: boolean; upstreamStatus: number | null }> {
    return this.#request("DELETE", this.#path(connectedAppId), undefined, signal);
  }

  #path(connectedAppId: string, action?: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(connectedAppId)) {
      throw new ConnectedAppVaultClientError("invalid_input", "connected app id is invalid", 400);
    }
    return `/connected-apps/${encodeURIComponent(connectedAppId)}${action ? `/${action}` : ""}`;
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
    const payload = await boundedJson(response);
    if (!response.ok) {
      const error = record(payload);
      const code = typeof error?.error === "string" ? error.error : "connected_app_vault_error";
      const message = typeof error?.message === "string" ? error.message : `Vault returned HTTP ${response.status}`;
      throw new ConnectedAppVaultClientError(code, message, response.status, payload);
    }
    return payload as T;
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new ConnectedAppVaultClientError(
          "connected_app_vault_response_too_large",
          "Vault connected-app response exceeds 4 MiB",
          502,
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ConnectedAppVaultClientError(
      "connected_app_vault_response_invalid",
      "Vault connected-app response is not JSON",
      502,
    );
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
