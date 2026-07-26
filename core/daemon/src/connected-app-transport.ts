import type { ResolvedConnectedAppCredential } from "./connected-app-authority.ts";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SSE_FRAME_BYTES = 1024 * 1024;
const REDACTED = "[REDACTED]";

export type ConnectedAppTransportResponse = Readonly<{
  status: number;
  messages: readonly unknown[];
}>;

export class ConnectedAppTransportError extends Error {
  readonly code: string;
  readonly upstreamStatus: number | null;
  readonly upstream?: unknown;

  constructor(code: string, message: string, upstreamStatus: number | null, upstream?: unknown) {
    super(message);
    this.name = "ConnectedAppTransportError";
    this.code = code;
    this.upstreamStatus = upstreamStatus;
    this.upstream = upstream;
  }
}

type TransportOptions = Readonly<{ fetch?: typeof globalThis.fetch }>;

/**
 * Core-owned MCP Streamable HTTP client.
 *
 * The authority resolves credentials before construction. This class retains
 * the Authorization value and MCP session ID only in private fields; neither
 * is included in normal results or transport errors.
 */
export class ConnectedAppTransport {
  readonly #resourceUrl: string;
  readonly #authorization: string;
  readonly #secrets: readonly string[];
  readonly #fetch: typeof globalThis.fetch;
  #sessionId: string | null = null;
  #protocolVersion: string | null = null;
  #initialized = false;
  #nextId = 1;

  constructor(credential: ResolvedConnectedAppCredential, options: TransportOptions = {}) {
    this.#resourceUrl = pinnedResourceUrl(credential.resourceUrl);
    const authorization = canonicalBearer(credential.authorization);
    this.#authorization = authorization.canonical;
    this.#secrets = [credential.authorization, authorization.canonical, authorization.token];
    this.#fetch = (options.fetch ?? globalThis.fetch).bind(globalThis);
  }

  /** Send initialize, capture MCP-Session-Id, then acknowledge initialization. */
  async initialize(params: unknown, signal?: AbortSignal): Promise<ConnectedAppTransportResponse> {
    if (this.#initialized || this.#sessionId) {
      throw new ConnectedAppTransportError("mcp_already_initialized", "connected app transport is already initialized", null);
    }
    const id = this.#requestId();
    const response = await this.#exchange("POST", { jsonrpc: "2.0", id, method: "initialize", params }, signal);
    const reply = response.messages.find((message) => isObject(message) && message.id === id);
    if (!isObject(reply)) {
      throw new ConnectedAppTransportError(
        "mcp_initialize_invalid",
        "connected app initialize response is missing",
        response.status,
        response.messages,
      );
    }
    if ("error" in reply) {
      throw new ConnectedAppTransportError(
        "mcp_initialize_failed",
        "connected app rejected initialization",
        response.status,
        reply.error,
      );
    }
    const result = isObject(reply.result) ? reply.result : null;
    this.#protocolVersion = validProtocolVersion(result?.protocolVersion, response.status);
    await this.notify("notifications/initialized", undefined, signal);
    this.#initialized = true;
    return response;
  }

  /** Send one JSON-RPC request with a transport-owned monotonic request ID. */
  async call(method: string, params?: unknown, signal?: AbortSignal): Promise<ConnectedAppTransportResponse> {
    validMethod(method);
    const id = this.#requestId();
    return this.#exchange("POST", {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    }, signal);
  }

  /** Send one JSON-RPC notification. A 202 response may have no body. */
  async notify(method: string, params?: unknown, signal?: AbortSignal): Promise<ConnectedAppTransportResponse> {
    validMethod(method);
    return this.#exchange("POST", {
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    }, signal);
  }

  /** DELETE the server-owned MCP session. With no session this is a no-op. */
  async close(signal?: AbortSignal): Promise<void> {
    if (this.#sessionId) await this.#exchange("DELETE", undefined, signal);
    this.#sessionId = null;
    this.#protocolVersion = null;
    this.#initialized = false;
  }

  #requestId(): number {
    if (!Number.isSafeInteger(this.#nextId)) {
      throw new ConnectedAppTransportError("mcp_request_id_exhausted", "connected app request ID space is exhausted", null);
    }
    return this.#nextId++;
  }

  async #exchange(method: "POST" | "DELETE", body: unknown, signal?: AbortSignal): Promise<ConnectedAppTransportResponse> {
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await this.#fetch(this.#resourceUrl, {
        method,
        redirect: "manual",
        headers: {
          authorization: this.#authorization,
          accept: "application/json, text/event-stream",
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
          ...(this.#sessionId ? { "mcp-session-id": this.#sessionId } : {}),
          ...(this.#protocolVersion ? { "mcp-protocol-version": this.#protocolVersion } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      throw new ConnectedAppTransportError(
        "mcp_transport_failed",
        "connected app transport request failed",
        null,
        { message: scrubString(error instanceof Error ? error.message : String(error), this.#secrets) },
      );
    }

    const expectedId = isObject(body) && (typeof body.id === "string" || typeof body.id === "number") ? body.id : undefined;
    const messages = await parseResponse(response, signal, this.#secrets, expectedId);
    if (!response.ok) {
      throw new ConnectedAppTransportError(
        "mcp_upstream_error",
        `connected app returned HTTP ${response.status}`,
        response.status,
        messages.length === 1 ? messages[0] : messages,
      );
    }
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId !== null) this.#sessionId = validSessionId(sessionId, response.status);
    if (expectedId !== undefined && !messages.some((message) => isObject(message) && message.id === expectedId)) {
      throw new ConnectedAppTransportError(
        "mcp_response_incomplete",
        "connected app response ended before the matching JSON-RPC reply",
        response.status,
        messages,
      );
    }
    return Object.freeze({ status: response.status, messages: Object.freeze(messages) });
  }
}

function pinnedResourceUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); }
  catch { throw new ConnectedAppTransportError("mcp_resource_invalid", "connected app resource URL is invalid", null); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new ConnectedAppTransportError(
      "mcp_resource_invalid",
      "connected app resource URL must be an exact HTTPS URL without credentials, query, or fragment",
      null,
    );
  }
  // Return the authority-provided string, not a derived origin or path.
  return input;
}

function canonicalBearer(input: string): { canonical: string; token: string } {
  if (typeof input !== "string" || /[\u0000-\u001f\u007f]/.test(input)) {
    throw new ConnectedAppTransportError("mcp_authorization_invalid", "connected app authorization is invalid", null);
  }
  const match = /^\s*bearer[ \t]+([^ \t]+)\s*$/i.exec(input);
  if (!match?.[1]) {
    throw new ConnectedAppTransportError("mcp_authorization_invalid", "connected app authorization must use Bearer", null);
  }
  return { canonical: `Bearer ${match[1]}`, token: match[1] };
}

function validMethod(method: string): void {
  if (typeof method !== "string" || method.length < 1 || method.length > 256 || /[\u0000-\u001f\u007f]/.test(method)) {
    throw new ConnectedAppTransportError("mcp_method_invalid", "connected app JSON-RPC method is invalid", null);
  }
}

function validSessionId(value: string, status: number): string {
  if (!value || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ConnectedAppTransportError("mcp_session_invalid", "connected app returned an invalid MCP session ID", status);
  }
  return value;
}

function validProtocolVersion(value: unknown, status: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64 || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new ConnectedAppTransportError("mcp_initialize_invalid", "connected app returned an invalid protocol version", status);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function parseResponse(
  response: Response,
  signal: AbortSignal | undefined,
  secrets: readonly string[],
  expectedId?: string | number,
): Promise<unknown[]> {
  signal?.throwIfAborted();
  if (!response.body) return [];
  const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (contentType === "text/event-stream") return parseEventStream(response.body, signal, secrets, response.status, expectedId);

  const text = await readBodyText(response.body, signal, response.status);
  if (!text) return [];
  if (contentType !== "application/json" && !contentType.endsWith("+json")) {
    throw new ConnectedAppTransportError(
      "mcp_content_type_invalid",
      "connected app returned an unsupported content type",
      response.status,
      scrubString(text, secrets),
    );
  }
  let payload: unknown;
  try { payload = JSON.parse(text); }
  catch {
    throw new ConnectedAppTransportError(
      "mcp_response_invalid",
      "connected app returned invalid JSON",
      response.status,
      scrubString(text, secrets),
    );
  }
  const sanitized = sanitize(payload, secrets);
  return Array.isArray(sanitized) ? sanitized : [sanitized];
}

async function readBodyText(body: ReadableStream<Uint8Array>, signal: AbortSignal | undefined, status: number): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new ConnectedAppTransportError("mcp_response_too_large", "connected app response exceeds 4 MiB", status);
      }
      text += decoder.decode(part.value, { stream: true });
    }
    signal?.throwIfAborted();
    return text + decoder.decode();
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function parseEventStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  secrets: readonly string[],
  status: number,
  expectedId?: string | number,
): Promise<unknown[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const messages: unknown[] = [];
  let buffer = "";
  let bytes = 0;
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  const consume = (frame: string): boolean => {
    const data = frame.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return false;
    let payload: unknown;
    try { payload = JSON.parse(data); }
    catch {
      throw new ConnectedAppTransportError(
        "mcp_response_invalid",
        "connected app returned invalid SSE JSON",
        status,
        scrubString(data, secrets),
      );
    }
    const message = sanitize(payload, secrets);
    messages.push(message);
    return expectedId !== undefined && isObject(message) && message.id === expectedId;
  };
  try {
    let matched = false;
    read:
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new ConnectedAppTransportError("mcp_response_too_large", "connected app response exceeds 4 MiB", status);
      }
      buffer += decoder.decode(part.value, { stream: true }).replace(/\r\n?/g, "\n");
      if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_FRAME_BYTES) {
        throw new ConnectedAppTransportError("mcp_frame_too_large", "connected app SSE frame exceeds 1 MiB", status);
      }
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        if (consume(frame)) {
          matched = true;
          break read;
        }
      }
    }
    signal?.throwIfAborted();
    if (!matched) {
      buffer += decoder.decode().replace(/\r\n?/g, "\n");
      if (buffer.trim()) matched = consume(buffer);
    }
    return messages;
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function sanitize(value: unknown, secrets: readonly string[], seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === "string") return scrubString(value, secrets);
  if (!value || typeof value !== "object") return value;
  const cached = seen.get(value);
  if (cached) return cached;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) result.push(sanitize(item, secrets, seen));
    return result;
  }
  const result: Record<string, unknown> = {};
  seen.set(value, result);
  for (const [key, item] of Object.entries(value)) {
    result[key] = key.toLowerCase() === "authorization" ? REDACTED : sanitize(item, secrets, seen);
  }
  return result;
}

function scrubString(value: string, secrets: readonly string[]): string {
  let output = value;
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join(REDACTED);
  }
  return output;
}
