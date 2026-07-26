export const FLOYD_EXPERIENCE_VERSION = "1.0.0";
export const FLOYD_SDK_PROTOCOL_VERSION = "1.0.0";

export class FloydApiError extends Error {
  constructor(method, path, status, payload) {
    const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
    super(`${method} ${path} -> ${status}: ${detail}`);
    this.name = "FloydApiError";
    this.method = method;
    this.path = path;
    this.status = status;
    this.payload = payload;
  }
}

/** Raised when a model SSE body ends without an explicit done/error frame. */
export class FloydStreamIncompleteError extends Error {
  constructor() {
    super("model stream ended before an explicit terminal event");
    this.name = "FloydStreamIncompleteError";
    this.code = "upstream_stream_incomplete";
  }
}

/** Browser build of the dependency-free Floyd Core client. */
export class FloydBrowserClient {
  constructor({ baseUrl = "", token, fetch: fetchImpl = globalThis.fetch }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.tokenSource = token;
    this.fetchImpl = fetchImpl.bind(globalThis);
  }

  async token() {
    return typeof this.tokenSource === "function" ? this.tokenSource() : this.tokenSource;
  }

  async request(method, path, body, signal) {
    const token = await this.token();
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      credentials: "same-origin",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
    const text = await response.text();
    let payload = text;
    if (text) {
      try { payload = JSON.parse(text); } catch { /* retain exact body */ }
    }
    if (!response.ok) throw new FloydApiError(method, path, response.status, payload);
    return payload;
  }

  health(signal) { return this.request("GET", "/api/health", undefined, signal); }
  state(signal) { return this.request("GET", "/api/state", undefined, signal); }
  run(id, signal) { return this.request("GET", `/api/runs/${encodeURIComponent(id)}`, undefined, signal); }
  evidence(id, signal) { return this.request("GET", `/api/evidence?run_id=${encodeURIComponent(id)}`, undefined, signal); }
  artifact(runId, role, signal) {
    return this.request("GET", `/api/runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(role)}`, undefined, signal);
  }
  artifactById(artifactId, signal) {
    return this.request("GET", `/api/artifacts/${encodeURIComponent(artifactId)}`, undefined, signal);
  }
  submit(projectId, goal, signal) {
    return this.request("POST", "/api/runs", { project_id: projectId, goal }, signal);
  }
  decide(runId, action, actor, signal) {
    return this.request("POST", `/api/runs/${encodeURIComponent(runId)}/decision`, { action, actor }, signal);
  }
  steer(sessionId, text, actor, signal, runId) {
    return this.request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/steer`, { type: "steer", text, actor, ...(runId ? { run_id: runId } : {}) }, signal);
  }
  answer(sessionId, requestId, answers, actor, signal, runId) {
    return this.request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/steer`, {
      type: "answer", request_id: requestId, answers, actor, ...(runId ? { run_id: runId } : {}),
    }, signal);
  }
  permission(sessionId, requestId, reply, actor, signal, runId) {
    return this.request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/steer`, {
      type: "permission", request_id: requestId, reply, actor, ...(runId ? { run_id: runId } : {}),
    }, signal);
  }

  /** Negotiate this surface's SDK, envelope versions, and capabilities. */
  negotiateExperience({
    surface_id,
    capabilities,
    sdk_version = FLOYD_SDK_PROTOCOL_VERSION,
    supported_envelope_versions = [FLOYD_EXPERIENCE_VERSION],
  }, signal) {
    return this.request("POST", "/api/experience/negotiate", {
      surface_id,
      sdk_version,
      supported_envelope_versions,
      capabilities,
    }, signal);
  }

  experience(envelopeId = "primary", signal) {
    return this.request("GET", `/api/experience/${encodeURIComponent(envelopeId)}`, undefined, signal);
  }

  /** Core preserves optimistic conflicts as HTTP 409; the SDK does not retry. */
  updateExperience(envelopeId, patch, signal) {
    return this.request("PATCH", `/api/experience/${encodeURIComponent(envelopeId)}`, patch, signal);
  }

  /** Resume with Last-Event-ID; stream() cancels the reader on break/abort. */
  watchExperience(envelopeId = "primary", options = {}) {
    return this.stream(`/api/experience/${encodeURIComponent(envelopeId)}/stream`, {
      lastEventId: options.lastEventId,
      signal: options.signal,
    });
  }

  enrollExperienceDevice(metadata, deviceId, signal) {
    return this.request("POST", "/api/devices/enroll", {
      metadata,
      ...(deviceId ? { device_id: deviceId } : {}),
    }, signal);
  }

  enrollExperienceDeviceWithScopes(metadata, allowedScopes, deviceId, signal) {
    return this.request("POST", "/api/devices/enroll", {
      metadata,
      allowed_scopes: allowedScopes,
      ...(deviceId ? { device_id: deviceId } : {}),
    }, signal);
  }

  authenticateExperienceDevice(deviceId, secret, signal) {
    return this.request("POST", "/api/devices/authenticate", { device_id: deviceId, secret }, signal);
  }

  revokeExperienceDevice(deviceId, signal) {
    return this.request("DELETE", `/api/devices/${encodeURIComponent(deviceId)}`, undefined, signal);
  }

  revokeCurrentDeviceSession(signal) {
    return this.request("DELETE", "/api/device-sessions/current", undefined, signal);
  }

  issueExperienceHandoff(input = {}, signal) {
    return this.request("POST", "/api/handoffs", input, signal);
  }

  consumeExperienceHandoff(token, deviceId, deviceSecret, signal) {
    return this.request("POST", "/api/handoffs/consume", {
      token,
      device_id: deviceId,
      device_secret: deviceSecret,
    }, signal);
  }

  pairExperienceHandoff(token, signal) {
    return this.request("POST", "/api/handoffs/pair", { token }, signal);
  }

  revokeExperienceHandoff(handoffId, signal) {
    return this.request("DELETE", `/api/handoffs/${encodeURIComponent(handoffId)}`, undefined, signal);
  }

  connectors(signal) {
    return this.request("GET", "/api/connectors", undefined, signal);
  }

  createConnector(input, signal) {
    return this.request("POST", "/api/connectors", input, signal);
  }

  storeConnectorApiKey(connectorId, apiKey, signal) {
    return this.request("POST", `/api/connectors/${encodeURIComponent(connectorId)}/api-key`, { apiKey }, signal);
  }

  startConnectorOAuth(connectorId, redirectUri, ttlMs, signal) {
    return this.request("POST", `/api/connectors/${encodeURIComponent(connectorId)}/oauth/start`, { redirectUri, ttlMs }, signal);
  }

  completeConnectorOAuth(state, code, signal) {
    return this.request("POST", "/api/connectors/oauth/callback", { state, code }, signal);
  }

  revokeConnector(connectorId, signal) {
    return this.request("DELETE", `/api/connectors/${encodeURIComponent(connectorId)}`, undefined, signal);
  }

  connectedApps(signal) {
    return this.request("GET", "/api/connected-apps", undefined, signal);
  }

  createConnectedApp(input, signal) {
    return this.request("POST", "/api/connected-apps", input, signal);
  }

  startConnectedAppOAuth(connectedAppId, ttlMs, signal) {
    return this.request("POST", `/api/connected-apps/${encodeURIComponent(connectedAppId)}/oauth/start`, { ttlMs }, signal);
  }

  refreshConnectedApp(connectedAppId, signal) {
    return this.request("POST", `/api/connected-apps/${encodeURIComponent(connectedAppId)}/refresh`, {}, signal);
  }

  revokeConnectedApp(connectedAppId, signal) {
    return this.request("DELETE", `/api/connected-apps/${encodeURIComponent(connectedAppId)}`, undefined, signal);
  }

  invokeConnectedApp(connectedAppId, request, signal) {
    return this.request("POST", `/api/connected-apps/${encodeURIComponent(connectedAppId)}/invoke`, request, signal);
  }

  /** Stream one user-configured provider through Core's normalized relay. */
  async *modelStream({ provider, apiKey, credentialRef, baseUrl, anthropicVersion, model, messages, signal }) {
    if (Boolean(apiKey) === Boolean(credentialRef)) {
      throw new Error("model route requires exactly one of apiKey or credentialRef");
    }
    const anthropic = provider === "anthropic" || (provider === "auto" && model.toLowerCase().startsWith("claude-"));
    const coreToken = await this.token();
    const response = await this.fetchImpl(`${this.baseUrl}/gateway`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...(coreToken ? { "x-floyd-token": coreToken } : {}),
        "x-floyd-provider": provider,
        ...(baseUrl ? { "x-floyd-base-url": baseUrl } : {}),
        ...(credentialRef ? { "x-floyd-credential-ref": credentialRef } : anthropic
          ? { "x-api-key": apiKey, "anthropic-version": anthropicVersion || "2023-06-01" }
          : { authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({ model, messages, stream: true }),
      signal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      let payload = text;
      try { payload = JSON.parse(text); } catch { /* retain exact vendor body */ }
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
        buffer = done ? "" : (frames.pop() || "");
        for (const frame of frames) {
          const type = frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
          const raw = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if ((type === "delta" || type === "done" || type === "error") && raw) {
            yield { type, data: JSON.parse(raw) };
            if (type === "done" || type === "error") {
              terminalSeen = true;
              return;
            }
          }
        }
        if (done) break;
      }
      if (!terminalSeen) throw new FloydStreamIncompleteError();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async *stream(path, { method = "GET", body, lastEventId, signal } = {}) {
    const token = await this.token();
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      credentials: "same-origin",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        accept: "text/event-stream",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(lastEventId ? { "last-event-id": lastEventId } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      let payload = text;
      try { payload = JSON.parse(text); } catch { /* retain exact body */ }
      throw new FloydApiError(method, path, response.status, payload);
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
          let id;
          let type = "message";
          const dataLines = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("id:")) id = line.slice(3).trim();
            else if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          if (!dataLines.length) continue;
          const raw = dataLines.join("\n");
          let data = raw;
          try { data = JSON.parse(raw); } catch { /* valid SSE may be text */ }
          yield { ...(id ? { id } : {}), type, data };
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  attachSession(sessionId, actor, options = {}) {
    return this.stream(`/api/sessions/${encodeURIComponent(sessionId)}/attach`, {
      method: "POST",
      body: { actor, ...(options.runId ? { run_id: options.runId } : {}) },
      lastEventId: options.lastEventId,
      signal: options.signal,
    });
  }
}
