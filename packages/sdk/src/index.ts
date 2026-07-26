import {
  FLOYD_EXPERIENCE_VERSION,
  FLOYD_SDK_PROTOCOL_VERSION,
  type EvidenceEvent,
  type ExperienceEnvelope,
  type ExperienceEnvelopePatch,
  type ExperienceDeviceEnrollment,
  type ExperienceDeviceSessionScope,
  type AuthenticatedExperienceDevice,
  type ExperienceHandoffConsumption,
  type ExperienceHandoffIssue,
  type ExperienceNegotiationRequest,
  type ExperienceNegotiationResult,
  type PairedExperienceHandoff,
  type Job,
  type Lease,
  type Project,
  type ProviderProfile,
  type ConnectorProfile,
  type ConnectorProfileInput,
  type ConnectorOAuthStart,
  type ConnectedAppProfile,
  type ConnectedAppProfileInput,
  type ConnectedAppOAuthStart,
  type ConnectedAppInvokeRequest,
  type ConnectedAppInvokeResponse,
  type Run,
  type Session,
} from "@floyd/contracts";

export { FLOYD_EXPERIENCE_VERSION, FLOYD_SDK_PROTOCOL_VERSION };

export const DEFAULT_FLOYD_CORE_URL = "http://127.0.0.1:41414";

export interface FloydClientOptions {
  baseUrl?: string;
  token: string | (() => string | Promise<string>);
  fetch?: typeof globalThis.fetch;
}

export interface FloydState {
  projects: Project[];
  sessions: Session[];
  runs: Run[];
  jobs: Job[];
  leases: Lease[];
  provider_profiles: ProviderProfile[];
  experience: ExperienceEnvelope;
}

export interface FloydStreamEvent<T = unknown> {
  id?: string;
  type: string;
  data: T;
}

export interface FloydExperienceNegotiationInput {
  surface_id: string;
  capabilities: string[];
  /** Defaults to this SDK's protocol version. Override only for compatibility tests. */
  sdk_version?: string;
  /** Defaults to the envelope versions understood by this SDK release. */
  supported_envelope_versions?: string[];
}

export type FloydModelProvider = "opencode-zen" | "opencode-go" | "openai" | "anthropic" | "auto";

export interface FloydModelRoute {
  provider: FloydModelProvider;
  /** Raw provider secret for ephemeral use. Mutually exclusive with credentialRef. */
  apiKey?: string;
  /** Core-owned encrypted connector reference. Mutually exclusive with apiKey. */
  credentialRef?: string;
  baseUrl?: string;
  /** Optional explicit Anthropic version; Core defaults to 2023-06-01. */
  anthropicVersion?: string;
}

export interface FloydChatMessage {
  role: "system" | "user" | "assistant";
  content: unknown;
}

export interface FloydModelEvent {
  type: "delta" | "done" | "error";
  data: { text?: string; finish_reason?: string } | unknown;
}

export class FloydApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly payload: unknown;

  constructor(method: string, path: string, status: number, payload: unknown) {
    const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
    super(`${method} ${path} -> ${status}: ${detail}`);
    this.name = "FloydApiError";
    this.status = status;
    this.method = method;
    this.path = path;
    this.payload = payload;
  }
}

/** Raised when a model SSE body ends without an explicit done/error frame. */
export class FloydStreamIncompleteError extends Error {
  readonly code = "upstream_stream_incomplete";

  constructor() {
    super("model stream ended before an explicit terminal event");
    this.name = "FloydStreamIncompleteError";
  }
}

/** Zero-runtime-dependency client used by every Floyd presentation surface. */
export class FloydClient {
  readonly baseUrl: string;
  private readonly tokenSource: FloydClientOptions["token"];
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: FloydClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_FLOYD_CORE_URL).replace(/\/+$/, "");
    this.tokenSource = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async token(): Promise<string> {
    return typeof this.tokenSource === "function" ? this.tokenSource() : this.tokenSource;
  }

  async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const token = await this.token();
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
    const text = await response.text();
    let payload: unknown = text;
    if (text) {
      try { payload = JSON.parse(text); } catch { /* retain exact upstream text */ }
    }
    if (!response.ok) throw new FloydApiError(method, path, response.status, payload);
    return payload as T;
  }

  health(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request("GET", "/api/health", undefined, signal);
  }

  state(signal?: AbortSignal): Promise<FloydState> {
    return this.request("GET", "/api/state", undefined, signal);
  }

  registerProject(input: { name: string; root_path: string; test_command?: string }, signal?: AbortSignal): Promise<{ id: string }> {
    return this.request("POST", "/api/projects", input, signal);
  }

  submit(input: { project_id: string; goal: string }, signal?: AbortSignal): Promise<{ run_id: string; duplicate: boolean }> {
    return this.request("POST", "/api/runs", input, signal);
  }

  run(runId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/runs/${encodeURIComponent(runId)}`, undefined, signal);
  }

  artifactById(artifactId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request("GET", `/api/artifacts/${encodeURIComponent(artifactId)}`, undefined, signal);
  }

  evidence(runId?: string, signal?: AbortSignal): Promise<{ events: EvidenceEvent[] }> {
    const query = runId ? `?run_id=${encodeURIComponent(runId)}` : "";
    return this.request("GET", `/api/evidence${query}`, undefined, signal);
  }

  steer(sessionId: string, text: string, actor: string, signal?: AbortSignal, runId?: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/steer`, {
      type: "steer", text, actor, ...(runId ? { run_id: runId } : {}),
    }, signal);
  }

  answer(sessionId: string, requestId: string, answers: string[][], actor: string, signal?: AbortSignal, runId?: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/steer`, {
      type: "answer", request_id: requestId, answers, actor, ...(runId ? { run_id: runId } : {}),
    }, signal);
  }

  permission(
    sessionId: string,
    requestId: string,
    reply: "once" | "always" | "reject",
    actor: string,
    signal?: AbortSignal,
    runId?: string,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/steer`, {
      type: "permission", request_id: requestId, reply, actor, ...(runId ? { run_id: runId } : {}),
    }, signal);
  }

  /**
   * Negotiate the portable experience protocol before a surface attaches.
   * Core returns HTTP 426 unchanged when this SDK/envelope combination cannot
   * participate, allowing the surface to render the actual upgrade guidance.
   */
  negotiateExperience(
    input: FloydExperienceNegotiationInput,
    signal?: AbortSignal,
  ): Promise<ExperienceNegotiationResult> {
    const request: ExperienceNegotiationRequest = {
      surface_id: input.surface_id,
      sdk_version: input.sdk_version ?? FLOYD_SDK_PROTOCOL_VERSION,
      supported_envelope_versions: input.supported_envelope_versions ?? [FLOYD_EXPERIENCE_VERSION],
      capabilities: input.capabilities,
    };
    return this.request("POST", "/api/experience/negotiate", request, signal);
  }

  experience(envelopeId = "primary", signal?: AbortSignal): Promise<ExperienceEnvelope> {
    return this.request("GET", `/api/experience/${encodeURIComponent(envelopeId)}`, undefined, signal);
  }

  /**
   * Apply an optimistic update. expected_revision is mandatory in the contract;
   * a stale writer receives Core's exact HTTP 409 payload rather than a retry
   * that could silently overwrite another surface's draft or selected context.
   */
  updateExperience(
    envelopeId: string,
    patch: ExperienceEnvelopePatch,
    signal?: AbortSignal,
  ): Promise<ExperienceEnvelope> {
    return this.request("PATCH", `/api/experience/${encodeURIComponent(envelopeId)}`, patch, signal);
  }

  /**
   * Watch the authoritative envelope. Last-Event-ID resumes after the caller's
   * last applied revision; stopping iteration cancels and releases the reader.
   */
  watchExperience(
    envelopeId = "primary",
    options: { lastEventId?: string; signal?: AbortSignal } = {},
  ): AsyncGenerator<FloydStreamEvent<ExperienceEnvelope>> {
    return this.stream(`/api/experience/${encodeURIComponent(envelopeId)}/stream`, {
      lastEventId: options.lastEventId,
      signal: options.signal,
    }) as AsyncGenerator<FloydStreamEvent<ExperienceEnvelope>>;
  }

  enrollExperienceDevice(
    metadata: Record<string, unknown>,
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<ExperienceDeviceEnrollment> {
    return this.request("POST", "/api/devices/enroll", {
      metadata,
      ...(deviceId ? { device_id: deviceId } : {}),
    }, signal);
  }

  enrollExperienceDeviceWithScopes(
    metadata: Record<string, unknown>,
    allowedScopes: ExperienceDeviceSessionScope[],
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<ExperienceDeviceEnrollment> {
    return this.request("POST", "/api/devices/enroll", {
      metadata,
      allowed_scopes: allowedScopes,
      ...(deviceId ? { device_id: deviceId } : {}),
    }, signal);
  }

  authenticateExperienceDevice(
    deviceId: string,
    secret: string,
    signal?: AbortSignal,
  ): Promise<AuthenticatedExperienceDevice> {
    return this.request("POST", "/api/devices/authenticate", { device_id: deviceId, secret }, signal);
  }

  revokeExperienceDevice(deviceId: string, signal?: AbortSignal): Promise<{ device_id: string; revoked: true }> {
    return this.request("DELETE", `/api/devices/${encodeURIComponent(deviceId)}`, undefined, signal);
  }

  revokeCurrentDeviceSession(signal?: AbortSignal): Promise<{ session_id: string; revoked: true }> {
    return this.request("DELETE", "/api/device-sessions/current", undefined, signal);
  }

  issueExperienceHandoff(
    input: { envelope_id?: string; envelope_revision?: number; created_by_device_id?: string; ttl_ms?: number; scopes?: ExperienceDeviceSessionScope[] } = {},
    signal?: AbortSignal,
  ): Promise<ExperienceHandoffIssue> {
    return this.request("POST", "/api/handoffs", input, signal);
  }

  consumeExperienceHandoff(
    token: string,
    deviceId: string,
    deviceSecret: string,
    signal?: AbortSignal,
  ): Promise<ExperienceHandoffConsumption> {
    return this.request("POST", "/api/handoffs/consume", {
      token,
      device_id: deviceId,
      device_secret: deviceSecret,
    }, signal);
  }

  pairExperienceHandoff(token: string, signal?: AbortSignal): Promise<PairedExperienceHandoff> {
    return this.request("POST", "/api/handoffs/pair", { token }, signal);
  }

  revokeExperienceHandoff(handoffId: string, signal?: AbortSignal): Promise<{ handoff_id: string; revoked: true }> {
    return this.request("DELETE", `/api/handoffs/${encodeURIComponent(handoffId)}`, undefined, signal);
  }

  connectors(signal?: AbortSignal): Promise<{ connectors: ConnectorProfile[] }> {
    return this.request("GET", "/api/connectors", undefined, signal);
  }

  createConnector(input: ConnectorProfileInput, signal?: AbortSignal): Promise<ConnectorProfile> {
    return this.request("POST", "/api/connectors", input, signal);
  }

  storeConnectorApiKey(connectorId: string, apiKey: string, signal?: AbortSignal): Promise<{ credentialRef: string }> {
    return this.request("POST", `/api/connectors/${encodeURIComponent(connectorId)}/api-key`, { apiKey }, signal);
  }

  startConnectorOAuth(connectorId: string, redirectUri: string, ttlMs?: number, signal?: AbortSignal): Promise<ConnectorOAuthStart> {
    return this.request("POST", `/api/connectors/${encodeURIComponent(connectorId)}/oauth/start`, { redirectUri, ttlMs }, signal);
  }

  completeConnectorOAuth(state: string, code: string, signal?: AbortSignal): Promise<{ credentialRef: string }> {
    return this.request("POST", "/api/connectors/oauth/callback", { state, code }, signal);
  }

  revokeConnector(connectorId: string, signal?: AbortSignal): Promise<{ connectorId: string; revoked: boolean; upstreamStatus: number | null }> {
    return this.request("DELETE", `/api/connectors/${encodeURIComponent(connectorId)}`, undefined, signal);
  }

  connectedApps(signal?: AbortSignal): Promise<{ connectedApps: ConnectedAppProfile[] }> {
    return this.request("GET", "/api/connected-apps", undefined, signal);
  }

  createConnectedApp(input: ConnectedAppProfileInput, signal?: AbortSignal): Promise<ConnectedAppProfile> {
    return this.request("POST", "/api/connected-apps", input, signal);
  }

  startConnectedAppOAuth(connectedAppId: string, ttlMs?: number, signal?: AbortSignal): Promise<ConnectedAppOAuthStart> {
    return this.request("POST", `/api/connected-apps/${encodeURIComponent(connectedAppId)}/oauth/start`, { ttlMs }, signal);
  }

  refreshConnectedApp(connectedAppId: string, signal?: AbortSignal): Promise<{ connectedAppId: string; expiresAt: string | null }> {
    return this.request("POST", `/api/connected-apps/${encodeURIComponent(connectedAppId)}/refresh`, {}, signal);
  }

  revokeConnectedApp(connectedAppId: string, signal?: AbortSignal): Promise<{ connectedAppId: string; revoked: boolean; upstreamStatus: number | null }> {
    return this.request("DELETE", `/api/connected-apps/${encodeURIComponent(connectedAppId)}`, undefined, signal);
  }

  invokeConnectedApp(
    connectedAppId: string,
    request: ConnectedAppInvokeRequest,
    signal?: AbortSignal,
  ): Promise<ConnectedAppInvokeResponse> {
    return this.request("POST", `/api/connected-apps/${encodeURIComponent(connectedAppId)}/invoke`, request, signal);
  }

  /**
   * Parse Core's SSE into one transport-neutral async stream.
   *
   * When the caller aborts or stops iteration, reader.cancel() propagates the
   * disconnect to Floyd Core. Core then drops the subscriber immediately; no
   * browser tab or client surface retains an unread response buffer.
   */
  async *stream(path: string, options: { method?: "GET" | "POST"; body?: unknown; lastEventId?: string; signal?: AbortSignal } = {}): AsyncGenerator<FloydStreamEvent> {
    const token = await this.token();
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        accept: "text/event-stream",
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(options.lastEventId ? { "last-event-id": options.lastEventId } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      let payload: unknown = text;
      try { payload = JSON.parse(text); } catch { /* preserve text */ }
      throw new FloydApiError(options.method ?? "GET", path, response.status, payload);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          let id: string | undefined;
          let type = "message";
          const dataLines: string[] = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("id:")) id = line.slice(3).trim();
            else if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          if (dataLines.length === 0) continue;
          const raw = dataLines.join("\n");
          let data: unknown = raw;
          try { data = JSON.parse(raw); } catch { /* valid SSE may contain plain text */ }
          yield { ...(id ? { id } : {}), type, data };
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  attachSession(sessionId: string, actor: string, options: { lastEventId?: string; signal?: AbortSignal; runId?: string } = {}): AsyncGenerator<FloydStreamEvent> {
    return this.stream(`/api/sessions/${encodeURIComponent(sessionId)}/attach`, {
      method: "POST",
      body: { actor, ...(options.runId ? { run_id: options.runId } : {}) },
      lastEventId: options.lastEventId,
      signal: options.signal,
    });
  }

  watchRun(runId: string, signal?: AbortSignal): AsyncGenerator<FloydStreamEvent> {
    return this.stream(`/api/runs/${encodeURIComponent(runId)}/stream`, { signal });
  }
}

/**
 * Unified zero-dependency chat driver for the Core /gateway relay.
 * Provider credentials are attached only to this one request and are never
 * persisted by the SDK. Local Core auth uses x-floyd-token, leaving the
 * provider Authorization/x-api-key headers intact for transparent forwarding.
 */
export class FloydModelClient {
  readonly baseUrl: string;
  private readonly tokenSource: FloydClientOptions["token"];
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: FloydClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_FLOYD_CORE_URL).replace(/\/+$/, "");
    this.tokenSource = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async token(): Promise<string> {
    return typeof this.tokenSource === "function" ? this.tokenSource() : this.tokenSource;
  }

  async *streamChat(input: {
    route: FloydModelRoute;
    model: string;
    messages: FloydChatMessage[];
    temperature?: number;
    max_tokens?: number;
    signal?: AbortSignal;
  }): AsyncGenerator<FloydModelEvent> {
    if (Boolean(input.route.apiKey) === Boolean(input.route.credentialRef)) {
      throw new Error("model route requires exactly one of apiKey or credentialRef");
    }
    const anthropic = input.route.provider === "anthropic"
      || (input.route.provider === "auto" && input.model.toLowerCase().startsWith("claude-"));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-floyd-token": await this.token(),
      "x-floyd-provider": input.route.provider,
      ...(input.route.baseUrl ? { "x-floyd-base-url": input.route.baseUrl } : {}),
      ...(input.route.credentialRef ? { "x-floyd-credential-ref": input.route.credentialRef } : anthropic
        ? {
            "x-api-key": input.route.apiKey!,
            "anthropic-version": input.route.anthropicVersion ?? "2023-06-01",
          }
        : { authorization: `Bearer ${input.route.apiKey!}` }),
    };
    const response = await this.fetchImpl(`${this.baseUrl}/gateway`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        stream: true,
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.max_tokens !== undefined ? { max_tokens: input.max_tokens } : {}),
      }),
      signal: input.signal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      let payload: unknown = text;
      try { payload = JSON.parse(text); } catch { /* preserve exact vendor text */ }
      throw new FloydApiError("POST", "/gateway", response.status, payload);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let terminalSeen = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        buffer += (done ? decoder.decode() : decoder.decode(value, { stream: true })).replace(/\r\n?/g, "\n");
        const frames = buffer.split("\n\n");
        buffer = done ? "" : (frames.pop() ?? "");
        for (const frame of frames) {
          let type: "delta" | "done" | "error" | null = null;
          const data: string[] = [];
          for (const line of frame.split("\n")) {
            if (line === "event: delta") type = "delta";
            else if (line === "event: done") type = "done";
            else if (line === "event: error") type = "error";
            else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
          }
          if (!type || data.length === 0) continue;
          yield { type, data: JSON.parse(data.join("\n")) as FloydModelEvent["data"] };
          if (type === "done" || type === "error") {
            terminalSeen = true;
            return;
          }
        }
        if (done) break;
      }
      if (!terminalSeen) throw new FloydStreamIncompleteError();
    } finally {
      // Cancelling the browser reader closes /gateway; Core's close listener
      // then destroys both the provider response and its outbound socket.
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
