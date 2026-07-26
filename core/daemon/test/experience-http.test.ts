import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";

const runtimeRoot = mkdtempSync(join(tmpdir(), "floyd-experience-http-"));
process.env.FLOYD_RUNTIME_ROOT = runtimeRoot;
process.env.FLOYD_CORE_PORT = "0";
process.env.FLOYD_REMOTE_CORE_PORT = "0";
process.env.FLOYD_REMOTE_ORIGIN = "https://floyd.test";
mkdirSync(join(runtimeRoot, "core"), { recursive: true, mode: 0o700 });

const { openDb } = await import("../src/db.ts");
const { gatewayToken } = await import("../src/config.ts");
const { startGateway, startRemoteGateway, startRemoteSurfaceGateways, pumpSessionChannel, writeRunEvent } = await import("../src/http.ts");
const { synchronizePendingInteractions } = await import("../src/experience.ts");
const { putArtifact, linkRunArtifact } = await import("../src/artifacts.ts");

const db = openDb(join(runtimeRoot, "core", "http.db"));
let pendingProviderAvailable = false;
let pendingSnapshotHook: (() => void) | null = null;
let pendingPermissionsResult: Array<Record<string, unknown>> = [];
let pendingPermissionPause: Promise<void> | null = null;
let pendingPermissionEntered: (() => void) | null = null;
let messageSnapshotHook: (() => void) | null = null;
const engine = {
  isHealthy: async () => true,
  baseUrl: "http://127.0.0.1:9",
  child: null,
  messages: async (engineSessionId: string) => {
    pumpSessionChannel(db, {
      type: "message.part.text.delta",
      run_id: "run-http",
      job_id: "job-http",
      kind: "builder",
      engine_session_id: engineSessionId,
      is_permission_ask: false,
      properties: { delta: "duplicate live delta" },
    });
    messageSnapshotHook?.();
    messageSnapshotHook = null;
    return [
      { id: "message-assistant", type: "assistant", time: { created: 2 }, content: [{ type: "text", text: "snapshot answer" }] },
      { id: "message-user", type: "user", time: { created: 1 }, content: [{ type: "text", text: "snapshot question" }] },
    ];
  },
  pendingPermissions: async () => {
    if (!pendingProviderAvailable) throw new Error("provider unavailable");
    const result = pendingPermissionsResult;
    pendingSnapshotHook?.();
    pendingSnapshotHook = null;
    pendingPermissionEntered?.();
    pendingPermissionEntered = null;
    const pause = pendingPermissionPause;
    pendingPermissionPause = null;
    if (pause) await pause;
    return result;
  },
  pendingQuestions: async () => {
    if (!pendingProviderAvailable) throw new Error("provider unavailable");
    return [];
  },
  replyPermission: async () => { pendingPermissionsResult = []; },
  replyQuestion: async () => {},
  steer: async () => {},
} as never;
const surfaceManifest = JSON.parse(readFileSync(join(import.meta.dirname, "../../../ecosystem/surfaces.json"), "utf8")) as {
  surfaces: Array<{ id: string; integration: { commit: string } }>;
};
const surfaceCommit = (id: string) => surfaceManifest.surfaces.find((surface) => surface.id === id)!.integration.commit;
const expectedSurfaceIdentity = new Map([
  ["http://127.0.0.1:13010/api/health", { surface_id: "desktop", source_root: "/Volumes/Storage/FLOYD_WORKSTATION/intake/surfaces/desktop", source_commit: surfaceCommit("desktop") }],
  ["http://127.0.0.1:13012/api/health", { surface_id: "ide", source_root: "/Volumes/Storage/FLOYD_WORKSTATION/intake/surfaces/ide", source_commit: surfaceCommit("ide") }],
  ["http://127.0.0.1:13013/health", { surface_id: "pty", source_root: "/Volumes/Storage/FLOYD_WORKSTATION/intake/surfaces/pty", source_commit: surfaceCommit("pty") }],
  ["http://127.0.0.1:13014/health", { surface_id: "launcher", source_root: "/Volumes/Storage/FLOYD_WORKSTATION/intake/surfaces/launcher", source_commit: surfaceCommit("launcher") }],
]);
const observedSurfaceHealthUrls: string[] = [];
let mismatchedSurfaceId: string | null = null;
const connectedAppCalls: Array<{ url: string; method: string; form: URLSearchParams | null; body: unknown; headers: Headers }> = [];
const connectedAppFetch: typeof globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = init.method ?? "GET";
  const form = init.body instanceof URLSearchParams ? new URLSearchParams(init.body) : null;
  let body: unknown = null;
  if (typeof init.body === "string") {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
  const headers = new Headers(init.headers);
  connectedAppCalls.push({ url, method, form, body, headers });
  if (url === "https://mcp.http.test/mcp" && method === "GET") {
    return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer resource_metadata=\"https://mcp.http.test/.well-known/oauth-protected-resource/mcp\"" } });
  }
  if (url === "https://mcp.http.test/mcp" && method === "POST") {
    const message = body as { id?: number; method?: string };
    if (message.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0", id: message.id,
        result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "HTTP MCP", version: "1.0.0" } },
      }, { headers: { "mcp-session-id": "http-mcp-session" } });
    }
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message.method === "tools/list") {
      return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "notes.search" }] } });
    }
    return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } });
  }
  if (url === "https://mcp.http.test/mcp" && method === "DELETE") return new Response(null, { status: 204 });
  if (url === "https://mcp.http.test/.well-known/oauth-protected-resource/mcp") {
    return Response.json({ resource: "https://mcp.http.test/mcp", authorization_servers: ["https://auth.http.test"] });
  }
  if (url === "https://auth.http.test/.well-known/oauth-authorization-server") {
    return Response.json({
      issuer: "https://auth.http.test",
      authorization_endpoint: "https://auth.http.test/authorize",
      token_endpoint: "https://auth.http.test/token",
      registration_endpoint: "https://auth.http.test/register",
      revocation_endpoint: "https://auth.http.test/revoke",
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  }
  if (url === "https://auth.http.test/register") return Response.json({ client_id: "http-client" }, { status: 201 });
  if (url === "https://auth.http.test/token" && form?.get("grant_type") === "authorization_code") {
    return Response.json({ access_token: "http-access-one", refresh_token: "http-refresh-one", token_type: "Bearer", expires_in: 3600 });
  }
  if (url === "https://auth.http.test/token" && form?.get("grant_type") === "refresh_token") {
    return Response.json({ access_token: "http-access-two", refresh_token: "http-refresh-two", token_type: "Bearer", expires_in: 3600 });
  }
  if (url === "https://auth.http.test/revoke") return new Response(null, { status: 204 });
  throw new Error(`unexpected connected app request ${url}`);
};
const surfaceHealthFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  observedSurfaceHealthUrls.push(url);
  if (init?.signal?.aborted) throw init.signal.reason;
  const identity = expectedSurfaceIdentity.get(url);
  if (!identity) return new Response("not found", { status: 404 });
  return Response.json({
    status: "ok",
    identity: identity.surface_id === mismatchedSurfaceId ? { ...identity, source_commit: "donor-or-stale-commit" } : identity,
  });
};
const server = startGateway(db, engine, process.pid, new Date().toISOString(), { surfaceHealthFetch, connectedAppFetch });
const remoteServer = startRemoteGateway(db, engine, process.pid, new Date().toISOString(), { connectedAppFetch });
if (!server.listening) await once(server, "listening");
if (!remoteServer.listening) await once(remoteServer, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("HTTP test server did not bind TCP");
const baseUrl = `http://127.0.0.1:${address.port}`;
const remoteAddress = remoteServer.address();
if (!remoteAddress || typeof remoteAddress === "string") throw new Error("remote HTTP test server did not bind TCP");
const remotePort = remoteAddress.port;
const remoteBaseUrl = `http://127.0.0.1:${remotePort}`;
const authorization = { authorization: `Bearer ${gatewayToken()}` };

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...authorization,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
}

async function selfAuthenticatedPost(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function remoteApi(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${remoteBaseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
}

async function remoteSelfAuthenticatedPost(path: string, body: unknown, origin = "https://floyd.test"): Promise<Response> {
  return fetch(`${remoteBaseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

test("run SSE writer destroys slow clients instead of buffering indefinitely", () => {
  let destroyedWith: Error | undefined;
  const response = {
    write: () => false,
    destroy(error?: Error) {
      destroyedWith = error;
      return this;
    },
  } as never;
  assert.equal(writeRunEvent(response, "event: test\ndata: {}\n\n"), false);
  assert.match(destroyedWith?.message ?? "", /backpressure limit/);
});

test("Core surface discovery probes only fixed admitted URLs and fails closed on provenance mismatch", async () => {
  observedSurfaceHealthUrls.length = 0;
  mismatchedSurfaceId = null;
  const response = await api("/api/surfaces?url=http://127.0.0.1:3001/api/health");
  assert.equal(response.status, 200);
  const body = await response.json() as { surfaces: Array<{ id: string; target: string; verified: boolean }> };
  assert.deepEqual(body.surfaces.map(({ id, target, verified }) => ({ id, target, verified })), [
    { id: "desktop", target: "http://127.0.0.1:13010/", verified: true },
    { id: "ide", target: "http://127.0.0.1:13012/", verified: true },
    { id: "pty", target: "http://127.0.0.1:13013/", verified: true },
    { id: "launcher", target: "http://127.0.0.1:13014/", verified: true },
  ]);
  assert.deepEqual(observedSurfaceHealthUrls, [...expectedSurfaceIdentity.keys()]);
  assert.equal(observedSurfaceHealthUrls.some((url) => url.includes(":3001")), false);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);

  mismatchedSurfaceId = "pty";
  const mismatch = await api("/api/surfaces");
  const mismatchBody = await mismatch.json() as { surfaces: Array<{ id: string; verified: boolean; reason: string }> };
  assert.deepEqual(mismatchBody.surfaces.find(({ id }) => id === "pty"), {
    id: "pty",
    target: "http://127.0.0.1:13013/",
    verified: false,
    reason: "Health responded without the required admitted source identity.",
  });
  mismatchedSurfaceId = null;
});

test("Core health identifies whether it is running from a pinned release", async () => {
  const response = await api("/api/health");
  assert.equal(response.status, 200);
  const body = await response.json() as {
    ok: boolean;
    release: { source: string; source_commit: string | null; node_version: string };
  };
  assert.equal(body.ok, true);
  assert.deepEqual(body.release, {
    source: "working-tree",
    source_commit: null,
    built_at: null,
    node_version: process.version,
  });
});

test("Cockpit and browser SDK cannot be reused from a stale browser cache after Core restart", async () => {
  for (const path of ["/", "/floyd-sdk.js"]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    await response.body?.cancel();
  }
});

test("local Cockpit exchanges its bootstrap token for a revocable HttpOnly loopback session", async () => {
  const missingOrigin = await fetch(`${baseUrl}/api/local-session`, {
    method: "POST",
    headers: authorization,
  });
  assert.equal(missingOrigin.status, 403);

  const hostileOrigin = await fetch(`${baseUrl}/api/local-session`, {
    method: "POST",
    headers: { ...authorization, origin: "https://attacker.example" },
  });
  assert.equal(hostileOrigin.status, 403);

  const bootstrapped = await fetch(`${baseUrl}/api/local-session`, {
    method: "POST",
    headers: { ...authorization, origin: baseUrl, "sec-fetch-site": "same-origin" },
  });
  assert.equal(bootstrapped.status, 201);
  assert.match(bootstrapped.headers.get("cache-control") ?? "", /no-store/);
  const bodyText = await bootstrapped.text();
  assert.doesNotMatch(bodyText, /token|secret|credential/i);
  const cookie = (bootstrapped.headers.get("set-cookie") ?? "").split(";")[0]!;
  assert.match(cookie, /^floyd_local_session=/);
  assert.match(bootstrapped.headers.get("set-cookie") ?? "", /HttpOnly/);
  assert.match(bootstrapped.headers.get("set-cookie") ?? "", /SameSite=Strict/);

  const state = await fetch(`${baseUrl}/api/state`, { headers: { cookie } });
  assert.equal(state.status, 200);
  await state.body?.cancel();

  const csrf = await fetch(`${baseUrl}/api/handoffs/nonexistent`, {
    method: "DELETE",
    headers: { cookie, origin: "https://attacker.example" },
  });
  assert.equal(csrf.status, 403);
  const mutation = await fetch(`${baseUrl}/api/handoffs/nonexistent`, {
    method: "DELETE",
    headers: { cookie, origin: baseUrl, "sec-fetch-site": "same-origin" },
  });
  assert.equal(mutation.status, 404);

  const revoked = await fetch(`${baseUrl}/api/local-session`, {
    method: "DELETE",
    headers: { cookie, origin: baseUrl, "sec-fetch-site": "same-origin" },
  });
  assert.equal(revoked.status, 200);
  assert.match(revoked.headers.get("set-cookie") ?? "", /Max-Age=0/);
  const afterRevoke = await fetch(`${baseUrl}/api/state`, { headers: { cookie } });
  assert.equal(afterRevoke.status, 401);
});

test("HTTP experience integration negotiates, streams, updates, and preserves conflicts", async () => {
  const queryAuth = await fetch(`${baseUrl}/api/health?token=${encodeURIComponent(gatewayToken())}`);
  assert.equal(queryAuth.status, 401);
  const negotiation = await api("/api/experience/negotiate", {
    method: "POST",
    body: JSON.stringify({
      surface_id: "http-test",
      sdk_version: "1.0.0",
      supported_envelope_versions: ["1.0.0"],
      capabilities: ["drafts", "experience-stream"],
    }),
  });
  assert.equal(negotiation.status, 200);
  assert.equal((await negotiation.json() as { accepted: boolean }).accepted, true);

  const firstResponse = await api("/api/experience/primary");
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json() as { revision: number; surfaces: Record<string, unknown> };
  assert.equal(first.revision, 1);
  assert.ok(first.surfaces["http-test"]);

  const streamAbort = new AbortController();
  const stream = await api("/api/experience/primary/stream", {
    headers: { accept: "text/event-stream", "last-event-id": "0" },
    signal: streamAbort.signal,
  });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  let streamText = "";
  try {
    for (let readCount = 0; readCount < 4 && !streamText.includes("event: experience"); readCount += 1) {
      const next = await reader.read();
      if (next.done) break;
      streamText += new TextDecoder().decode(next.value);
    }
    assert.match(streamText, /event: hello/);
    assert.match(streamText, /event: experience/);
    assert.match(streamText, /"revision":1/);
  } finally {
    streamAbort.abort();
    await reader.cancel().catch(() => {});
  }

  const futureAbort = new AbortController();
  const futureStream = await api("/api/experience/primary/stream", {
    headers: { accept: "text/event-stream", "last-event-id": "999999" },
    signal: futureAbort.signal,
  });
  const futureReader = futureStream.body!.getReader();
  let futureText = "";
  try {
    for (let readCount = 0; readCount < 4 && !futureText.includes("event: experience"); readCount += 1) {
      const next = await futureReader.read();
      if (next.done) break;
      futureText += new TextDecoder().decode(next.value);
    }
    assert.match(futureText, /event: experience/);
    assert.match(futureText, /"revision":1/);
  } finally {
    futureAbort.abort();
    await futureReader.cancel().catch(() => {});
  }

  const updatedResponse = await api("/api/experience/primary", {
    method: "PATCH",
    body: JSON.stringify({ expected_revision: first.revision, composer_draft: "portable draft", selected_view: "run" }),
  });
  assert.equal(updatedResponse.status, 200);
  const updated = await updatedResponse.json() as { revision: number; composer_draft: string };
  assert.equal(updated.revision, 2);
  assert.equal(updated.composer_draft, "portable draft");

  const conflict = await api("/api/experience/primary", {
    method: "PATCH",
    body: JSON.stringify({ expected_revision: first.revision, composer_draft: "stale overwrite" }),
  });
  assert.equal(conflict.status, 409);
  const conflictBody = await conflict.json() as { error: string; actual_revision: number; envelope: { composer_draft: string } };
  assert.equal(conflictBody.error, "revision_conflict");
  assert.equal(conflictBody.actual_revision, 2);
  assert.equal(conflictBody.envelope.composer_draft, "portable draft");

  const forgedPending = await api("/api/experience/primary", {
    method: "PATCH",
    body: JSON.stringify({ expected_revision: updated.revision, pending_permissions: [{ id: "forged" }] }),
  });
  assert.equal(forgedPending.status, 400);
  assert.match((await forgedPending.json() as { error: string }).error, /Core-owned/);
  const spoofedDevice = await api("/api/experience/primary", {
    method: "PATCH",
    body: JSON.stringify({ expected_revision: updated.revision, device_id: "spoofed-device", selected_view: "spoofed" }),
  });
  assert.equal(spoofedDevice.status, 400);
  assert.match((await spoofedDevice.json() as { error: string }).error, /device-scoped/);

  for (const malformedBody of ["null", "[]", "42", JSON.stringify("text")]) {
    const malformed = await api("/api/experience/primary", { method: "PATCH", body: malformedBody });
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json() as { error: string }).error, /JSON object/);
  }
  const invalidJson = await api("/api/experience/primary", { method: "PATCH", body: "{" });
  assert.equal(invalidJson.status, 400);
  assert.equal((await invalidJson.json() as { error: string }).error, "invalid_json");

  const incompatible = await api("/api/experience/negotiate", {
    method: "POST",
    body: JSON.stringify({
      surface_id: "old-surface",
      sdk_version: "0.0.1",
      supported_envelope_versions: ["0.1.0"],
      capabilities: [],
    }),
  });
  assert.equal(incompatible.status, 426);
  assert.equal((await incompatible.json() as { error: string }).error, "sdk_upgrade_required");
});

test("HTTP device and one-time handoff lifecycle returns the bound envelope", async () => {
  const blockedEnrollment = await selfAuthenticatedPost("/api/devices/enroll", { metadata: {} });
  assert.equal(blockedEnrollment.status, 401);
  const enrollment = await api("/api/devices/enroll", {
    method: "POST",
    body: JSON.stringify({ device_id: "device-http-test", metadata: { surface: "test" } }),
  });
  assert.equal(enrollment.status, 201);
  const device = await enrollment.json() as { device_id: string; secret: string };

  const hostileOrigin = await remoteSelfAuthenticatedPost(
    "/api/devices/authenticate",
    { device_id: device.device_id, secret: device.secret },
    "https://attacker.test",
  );
  assert.equal(hostileOrigin.status, 403);

  const authenticated = await remoteSelfAuthenticatedPost("/api/devices/authenticate", { device_id: device.device_id, secret: device.secret });
  assert.equal(authenticated.status, 200);
  const authenticatedBody = await authenticated.json() as { metadata: unknown; session: { token: string; scopes: string[] } };
  assert.deepEqual(authenticatedBody.metadata, { surface: "test" });
  assert.deepEqual(authenticatedBody.session.scopes, ["health:read"]);
  assert.equal((await remoteApi("/api/health", authenticatedBody.session.token)).status, 200);
  assert.equal((await remoteApi("/api/surfaces", authenticatedBody.session.token)).status, 403);
  assert.equal((await remoteApi("/api/state", authenticatedBody.session.token)).status, 403);
  assert.equal((await remoteApi("/api/experience/primary", authenticatedBody.session.token)).status, 403);
  assert.equal((await remoteApi("/api/connectors", authenticatedBody.session.token)).status, 403);
  assert.equal((await remoteApi("/gateway", authenticatedBody.session.token, { method: "POST" })).status, 401);

  const envelope = await (await api("/api/experience/primary")).json() as { revision: number };
  const issue = await api("/api/handoffs", {
    method: "POST",
    body: JSON.stringify({
      envelope_id: "primary",
      envelope_revision: envelope.revision,
      created_by_device_id: device.device_id,
      ttl_ms: 30_000,
    }),
  });
  assert.equal(issue.status, 201);
  const handoff = await issue.json() as { token: string; deep_link: string; qr_svg: string; qr_content_type: string };
  assert.match(handoff.deep_link, /^https:\/\/floyd\.test\/#handoff=/);
  assert.equal(handoff.qr_content_type, "image/svg+xml");
  assert.match(handoff.qr_svg, /<svg/);
  assert.equal(handoff.qr_svg.includes(handoff.token), false);

  const consumed = await remoteSelfAuthenticatedPost("/api/handoffs/consume", {
    token: handoff.token,
    device_id: device.device_id,
    device_secret: device.secret,
  });
  assert.equal(consumed.status, 200);
  const consumedBody = await consumed.json() as { envelope: { id: string; revision: number }; session: { token: string; resources: { envelope_ids: string[] } } };
  assert.equal(consumedBody.envelope.id, "primary");
  assert.equal(consumedBody.envelope.revision, envelope.revision);
  assert.deepEqual(consumedBody.session.resources.envelope_ids, ["primary"]);
  assert.equal((await remoteApi("/api/experience/primary", consumedBody.session.token)).status, 200);
  const remoteState = await remoteApi("/api/state", consumedBody.session.token);
  assert.equal(remoteState.status, 200);
  const remoteStateText = await remoteState.text();
  const remoteStateBody = JSON.parse(remoteStateText) as { experience: { model_route: { credential_ref?: unknown } } };
  assert.equal(remoteStateBody.experience.model_route.credential_ref ?? null, null);
  assert.equal(remoteStateText.includes("floyd-connector:"), false);
  assert.equal(remoteStateText.includes("root_path"), false);
  const escapedActive = await remoteApi("/api/experience/primary", consumedBody.session.token, {
    method: "PATCH",
    body: JSON.stringify({ expected_revision: envelope.revision, active: { project_id: "project-outside-grant", session_id: null, run_id: null } }),
  });
  assert.equal(escapedActive.status, 403);
  const escapedModel = await remoteApi("/api/experience/primary", consumedBody.session.token, {
    method: "PATCH",
    body: JSON.stringify({ expected_revision: envelope.revision, model_route: { provider_profile_id: "outside" } }),
  });
  assert.equal(escapedModel.status, 403);
  assert.equal((await remoteApi("/api/experience/other", consumedBody.session.token)).status, 403);
  const logout = await remoteApi("/api/device-sessions/current", consumedBody.session.token, { method: "DELETE" });
  assert.equal(logout.status, 200);
  assert.equal((await remoteApi("/api/experience/primary", consumedBody.session.token)).status, 401);

  const replay = await selfAuthenticatedPost("/api/handoffs/consume", {
    token: handoff.token,
    device_id: device.device_id,
    device_secret: device.secret,
  });
  assert.equal(replay.status, 409);
  assert.equal((await replay.json() as { error: string }).error, "handoff_consumed");

  const beforeStale = await (await api("/api/experience/primary")).json() as { revision: number; selected_view: string };
  const staleIssue = await api("/api/handoffs", {
    method: "POST",
    body: JSON.stringify({ envelope_id: "primary", envelope_revision: beforeStale.revision, ttl_ms: 30_000 }),
  });
  const staleHandoff = await staleIssue.json() as { token: string };
  const advance = await api("/api/experience/primary", {
    method: "PATCH",
    body: JSON.stringify({ expected_revision: beforeStale.revision, selected_view: "advanced" }),
  });
  assert.equal(advance.status, 200);
  const staleConsume = await selfAuthenticatedPost("/api/handoffs/consume", {
    token: staleHandoff.token,
    device_id: device.device_id,
    device_secret: device.secret,
  });
  assert.equal(staleConsume.status, 200);
  const snapshotConsumption = await staleConsume.json() as { envelope: { revision: number; selected_view: string } };
  assert.equal(snapshotConsumption.envelope.revision, beforeStale.revision);
  assert.equal(snapshotConsumption.envelope.selected_view, beforeStale.selected_view);

  const pairBase = await (await api("/api/experience/primary")).json() as { revision: number };
  const pairIssue = await api("/api/handoffs", {
    method: "POST",
    body: JSON.stringify({ envelope_id: "primary", envelope_revision: pairBase.revision, ttl_ms: 30_000 }),
  });
  const pairGrant = await pairIssue.json() as { handoff_id: string; token: string };
  const pairToken = pairGrant.token;
  const missingOriginPair = await fetch(`${remoteBaseUrl}/api/handoffs/pair`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pairToken }),
  });
  assert.equal(missingOriginPair.status, 403);
  const loopbackOriginPair = await remoteSelfAuthenticatedPost("/api/handoffs/pair", { token: pairToken }, "http://127.0.0.1");
  assert.equal(loopbackOriginPair.status, 403);
  const paired = await remoteSelfAuthenticatedPost("/api/handoffs/pair", { token: pairToken });
  assert.equal(paired.status, 200);
  const pairCookie = paired.headers.get("set-cookie") ?? "";
  assert.match(pairCookie, /__Host-floyd_session=/);
  assert.match(pairCookie, /HttpOnly/);
  assert.match(pairCookie, /Secure/);
  assert.match(pairCookie, /SameSite=Strict/);
  const pairedText = await paired.text();
  assert.equal(pairedText.includes("fds_"), false);
  const pairedBody = JSON.parse(pairedText) as { session: { session_id: string; device_id: string } };
  const recoveredPair = await remoteSelfAuthenticatedPost("/api/handoffs/pair", { token: pairToken });
  assert.equal(recoveredPair.status, 200);
  const recoveredBody = await recoveredPair.json() as { session: { session_id: string; device_id: string } };
  assert.deepEqual(recoveredBody.session, pairedBody.session);
  const closeRecoveryWindow = await api(`/api/handoffs/${pairGrant.handoff_id}`, { method: "DELETE" });
  assert.equal(closeRecoveryWindow.status, 200);
  const revokedPairRetry = await remoteSelfAuthenticatedPost("/api/handoffs/pair", { token: pairToken });
  assert.equal(revokedPairRetry.status, 410);
  assert.equal((await revokedPairRetry.json() as { error: string }).error, "handoff_revoked");
  const cookieState = await fetch(`${remoteBaseUrl}/api/state`, { headers: { cookie: pairCookie.split(";")[0]! } });
  assert.equal(cookieState.status, 200);

  const malformedCookie = await fetch(`${remoteBaseUrl}/api/state`, {
    headers: { cookie: "__Host-floyd_session=%ZZ" },
  });
  assert.equal(malformedCookie.status, 401);

  const invalidPairBody = await remoteSelfAuthenticatedPost("/api/handoffs/pair", null);
  assert.equal(invalidPairBody.status, 400);
  assert.equal((await invalidPairBody.json() as { error: string }).error, "invalid_input");

  const priorQrBinary = process.env.FLOYD_QRENCODE_BIN;
  process.env.FLOYD_QRENCODE_BIN = join(runtimeRoot, "missing-qrencode");
  const failedQrIssue = await api("/api/handoffs", {
    method: "POST",
    body: JSON.stringify({ envelope_id: "primary", envelope_revision: pairBase.revision }),
  });
  if (priorQrBinary === undefined) delete process.env.FLOYD_QRENCODE_BIN;
  else process.env.FLOYD_QRENCODE_BIN = priorQrBinary;
  assert.equal(failedQrIssue.status, 503);
  const failedQrRow = db.prepare(`SELECT revoked_at FROM experience_handoffs ORDER BY rowid DESC LIMIT 1`).get() as { revoked_at: string | null };
  assert.notEqual(failedQrRow.revoked_at, null);

  const currentEnvelope = await (await api("/api/experience/primary")).json() as { revision: number };
  const streamIssue = await api("/api/handoffs", {
    method: "POST",
    body: JSON.stringify({ envelope_id: "primary", envelope_revision: currentEnvelope.revision }),
  });
  const streamHandoff = await streamIssue.json() as { token: string };
  const streamConsume = await remoteSelfAuthenticatedPost("/api/handoffs/consume", {
    token: streamHandoff.token,
    device_id: device.device_id,
    device_secret: device.secret,
  });
  const streamSession = await streamConsume.json() as { session: { token: string } };
  const streamResponse = await remoteApi("/api/experience/primary/stream", streamSession.session.token, {
    headers: { accept: "text/event-stream" },
  });
  assert.equal(streamResponse.status, 200);
  const streamReader = streamResponse.body!.getReader();
  assert.equal((await streamReader.read()).done, false);
  const revokedDevice = await api(`/api/devices/${encodeURIComponent(device.device_id)}`, { method: "DELETE" });
  assert.equal(revokedDevice.status, 200);
  const closed = await Promise.race([
    (async () => {
      for (let read = 0; read < 5; read += 1) {
        try {
          if ((await streamReader.read()).done) return true;
        } catch {
          return true;
        }
      }
      return false;
    })(),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
  ]);
  assert.equal(closed, true);
  assert.equal((await remoteApi("/api/experience/primary", streamSession.session.token)).status, 403);
});

test("remote surface relays require a scoped device session, strip credentials, and relay WebSocket teardown", async () => {
  const enrollment = await api("/api/devices/enroll", {
    method: "POST",
    body: JSON.stringify({ device_id: "relay-device", metadata: { surface: "remote-relay-test" } }),
  });
  const device = await enrollment.json() as { device_id: string; secret: string };
  const envelope = await (await api("/api/experience/primary")).json() as { revision: number };
  const issue = await api("/api/handoffs", {
    method: "POST",
    body: JSON.stringify({ envelope_id: "primary", envelope_revision: envelope.revision }),
  });
  const handoff = await issue.json() as { token: string };
  const consumed = await remoteSelfAuthenticatedPost("/api/handoffs/consume", {
    token: handoff.token,
    device_id: device.device_id,
    device_secret: device.secret,
  });
  const session = await consumed.json() as { session: { token: string } };

  let observedHeaders: Record<string, unknown> = {};
  let observedBody = "";
  let slowResponseClosed = false;
  const upgradedSockets = new Set<import("node:stream").Duplex>();
  const upstream = createServer(async (req, res) => {
    observedHeaders = req.headers;
    for await (const chunk of req) observedBody += String(chunk);
    if (req.url === "/slow") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("started");
      res.once("close", () => { slowResponseClosed = true; });
      return;
    }
    res.writeHead(201, { "content-type": "application/json", "set-cookie": "upstream=must-not-escape" });
    res.end(JSON.stringify({ ok: true }));
  });
  upstream.on("upgrade", (_req, socket) => {
    upgradedSockets.add(socket);
    socket.once("close", () => upgradedSockets.delete(socket));
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    socket.on("data", (chunk) => socket.write(chunk));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("surface test upstream did not bind TCP");
  const target = `http://127.0.0.1:${upstreamAddress.port}/`;
  const relays = startRemoteSurfaceGateways(db, {
    relayPorts: { desktop: 0, ide: 0, pty: 0, launcher: 0 },
    upstreamTargets: { desktop: target, ide: target, pty: target, launcher: target },
    surfaceHealthFetch,
  });
  await Promise.all(relays.map(({ server }) => server.listening ? undefined : once(server, "listening")));
  const desktopRelay = relays.find(({ id }) => id === "desktop")!.server;
  const relayAddress = desktopRelay.address();
  if (!relayAddress || typeof relayAddress === "string") throw new Error("surface relay did not bind TCP");
  const relayBase = `http://127.0.0.1:${relayAddress.port}`;

  try {
    assert.equal((await fetch(`${relayBase}/probe`)).status, 401);
    const response = await fetch(`${relayBase}/probe`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.session.token}`,
        cookie: "sensitive=must-not-forward",
        origin: "https://attacker.test",
        "content-type": "text/plain",
      },
      body: "relay-body",
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("content-security-policy"), "frame-ancestors https://floyd.test");
    assert.equal(observedHeaders.authorization, undefined);
    assert.equal(observedHeaders.cookie, undefined);
    assert.equal(observedHeaders.origin, target.slice(0, -1));
    assert.equal(observedBody, "relay-body");

    const hostileCookieMutation = await fetch(`${relayBase}/probe`, {
      method: "POST",
      headers: { cookie: `__Host-floyd_session=${session.session.token}`, origin: "https://attacker.test" },
    });
    assert.equal(hostileCookieMutation.status, 403);

    const socket = connect(relayAddress.port, "127.0.0.1");
    await once(socket, "connect");
    socket.write(
      "GET /ws HTTP/1.1\r\n"
      + `Host: 127.0.0.1:${relayAddress.port}\r\n`
      + "Connection: Upgrade\r\nUpgrade: websocket\r\n"
      + "Sec-WebSocket-Key: dGVzdC1rZXk=\r\nSec-WebSocket-Version: 13\r\n"
      + `Cookie: __Host-floyd_session=${session.session.token}\r\n`
      + "Origin: https://floyd.test:8444\r\n\r\n",
    );
    let received = "";
    while (!received.includes("\r\n\r\n")) received += String((await once(socket, "data"))[0]);
    assert.match(received, /^HTTP\/1\.1 101/);
    socket.write("relay-ws-probe");
    while (!received.includes("relay-ws-probe")) received += String((await once(socket, "data"))[0]);
    assert.match(received, /relay-ws-probe/);
    socket.destroy();

    const slow = await fetch(`${relayBase}/slow`, { headers: { authorization: `Bearer ${session.session.token}` } });
    const slowReader = slow.body!.getReader();
    assert.equal(new TextDecoder().decode((await slowReader.read()).value), "started");
    const revoked = await remoteApi("/api/device-sessions/current", session.session.token, { method: "DELETE" });
    assert.equal(revoked.status, 200);
    const terminated = await Promise.race([
      slowReader.read().then(({ done }) => done, () => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    assert.equal(terminated, true);
    assert.equal(slowResponseClosed, true);
  } finally {
    for (const socket of upgradedSockets) socket.destroy();
    for (const { server: relay } of relays) {
      relay.closeAllConnections();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("HTTP connector authority keeps secrets opaque and injects only endpoint-bound references", async () => {
  let upstreamAuthorization = "";
  const upstream = createServer(async (req, res) => {
    upstreamAuthorization = req.headers.authorization ?? "";
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"connector":"ok"}');
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("connector upstream did not bind");
  const apiKey = "connector-http-secret-value";
  try {
    const malformed = await api("/api/connectors", { method: "POST", body: "null" });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json() as { error: string }).error, "invalid_input");

    const created = await api("/api/connectors", {
      method: "POST",
      body: JSON.stringify({
        id: "http-openai",
        displayName: "HTTP OpenAI",
        provider: "openai",
        baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(await created.clone().text(), /secret/i);

    const stored = await api("/api/connectors/http-openai/api-key", {
      method: "POST",
      body: JSON.stringify({ apiKey }),
    });
    assert.equal(stored.status, 201);
    const storedBody = await stored.json() as { credentialRef: string };
    assert.equal(storedBody.credentialRef, "floyd-connector:http-openai");

    const listed = await api("/api/connectors");
    const listedText = await listed.text();
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(listedText, new RegExp(apiKey));
    assert.match(listedText, /floyd-connector:http-openai/);

    const gateway = await fetch(`${baseUrl}/gateway`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-floyd-token": gatewayToken(),
        "x-floyd-provider": "openai",
        "x-floyd-credential-ref": storedBody.credentialRef,
      },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hello" }], stream: false }),
    });
    assert.equal(gateway.status, 200);
    assert.equal(await gateway.text(), '{"connector":"ok"}');
    assert.equal(upstreamAuthorization, `Bearer ${apiKey}`);

    const ambiguous = await fetch(`${baseUrl}/gateway`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-floyd-token": gatewayToken(),
        "x-floyd-credential-ref": storedBody.credentialRef,
        authorization: "Bearer attacker-substitute",
      },
      body: JSON.stringify({ model: "gpt-test", messages: [], stream: false }),
    });
    assert.equal(ambiguous.status, 400);
    assert.equal((await ambiguous.json() as { error: string }).error, "credential_ambiguous");
  } finally {
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

test("HTTP connected-app OAuth keeps callback exchange server-owned and supports explicit refresh and revocation", async () => {
  connectedAppCalls.length = 0;
  const created = await api("/api/connected-apps", {
    method: "POST",
    body: JSON.stringify({ id: "http-notes", displayName: "HTTP Notes", resourceUrl: "https://mcp.http.test/mcp" }),
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json() as { id: string; resourceMetadataUrl: string; status: string };
  assert.equal(createdBody.id, "http-notes");
  assert.equal(createdBody.resourceMetadataUrl, "https://mcp.http.test/.well-known/oauth-protected-resource/mcp");
  assert.equal(createdBody.status, "discovered");

  const started = await api("/api/connected-apps/http-notes/oauth/start", { method: "POST", body: "{}" });
  assert.equal(started.status, 201);
  const startedBody = await started.json() as { authorizationUrl: string };
  const authorization = new URL(startedBody.authorizationUrl);
  assert.equal(authorization.searchParams.get("resource"), "https://mcp.http.test/mcp");
  const state = authorization.searchParams.get("state")!;

  const callback = await fetch(`${baseUrl}/api/connected-apps/oauth/callback?state=${encodeURIComponent(state)}&code=server-only-code`, {
    redirect: "manual",
  });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get("location"), "/?settings=connections&connected_app=http-notes");
  assert.equal(callback.headers.get("referrer-policy"), "no-referrer");
  const tokenCall = connectedAppCalls.find((call) => call.form?.get("grant_type") === "authorization_code")!;
  assert.equal(tokenCall.form!.get("code"), "server-only-code");
  assert.equal(tokenCall.form!.get("resource"), "https://mcp.http.test/mcp");

  const listedText = await (await api("/api/connected-apps")).text();
  assert.match(listedText, /"status":\s*"connected"/);
  assert.doesNotMatch(listedText, /http-access|http-refresh|server-only-code|credentialRef/);

  const refreshed = await api("/api/connected-apps/http-notes/refresh", { method: "POST", body: "{}" });
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json() as { connectedAppId: string }).connectedAppId, "http-notes");
  assert.equal(connectedAppCalls.filter((call) => call.form?.get("grant_type") === "refresh_token").length, 1);

  let envelope = await (await api("/api/experience/primary")).json() as { revision: number; connected_app_ids: string[] };
  const selected = await api("/api/experience/primary", {
    method: "PATCH",
    body: JSON.stringify({ expected_revision: envelope.revision, connected_app_ids: ["http-notes"] }),
  });
  assert.equal(selected.status, 200);
  envelope = await selected.json() as typeof envelope;
  assert.deepEqual(envelope.connected_app_ids, ["http-notes"]);

  const invoked = await api("/api/connected-apps/http-notes/invoke", {
    method: "POST",
    body: JSON.stringify({ method: "tools/list", params: {} }),
  });
  assert.equal(invoked.status, 200);
  const invokedText = await invoked.text();
  assert.deepEqual(JSON.parse(invokedText), {
    connectedAppId: "http-notes",
    status: 200,
    messages: [{ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "notes.search" }] } }],
  });
  assert.doesNotMatch(invokedText, /http-access|http-refresh|Authorization/i);
  const mcpCalls = connectedAppCalls.filter((call) => call.url === "https://mcp.http.test/mcp" && call.method !== "GET");
  assert.deepEqual(mcpCalls.map((call) => call.method), ["POST", "POST", "POST", "DELETE"]);
  assert.equal(mcpCalls[0]!.headers.get("authorization"), "Bearer http-access-two");
  assert.equal(mcpCalls[1]!.headers.get("mcp-session-id"), "http-mcp-session");
  assert.equal(mcpCalls[2]!.headers.get("mcp-protocol-version"), "2025-11-25");

  const remoteDeviceResponse = await api("/api/devices/enroll", {
    method: "POST",
    body: JSON.stringify({ device_id: "connected-app-http-device", metadata: { surface: "connected-app-test" } }),
  });
  const remoteDevice = await remoteDeviceResponse.json() as { device_id: string; secret: string };
  const handoffResponse = await api("/api/handoffs", {
    method: "POST",
    body: JSON.stringify({ envelope_id: "primary", envelope_revision: envelope.revision, created_by_device_id: remoteDevice.device_id }),
  });
  const handoff = await handoffResponse.json() as { token: string };
  const consumed = await remoteSelfAuthenticatedPost("/api/handoffs/consume", {
    token: handoff.token,
    device_id: remoteDevice.device_id,
    device_secret: remoteDevice.secret,
  });
  assert.equal(consumed.status, 200);
  const remoteSession = await consumed.json() as { session: { token: string; resources: { connected_app_ids: string[] } } };
  assert.deepEqual(remoteSession.session.resources.connected_app_ids, ["http-notes"]);
  const remoteListed = await remoteApi("/api/connected-apps", remoteSession.session.token);
  assert.equal(remoteListed.status, 200);
  assert.deepEqual((await remoteListed.json() as { connectedApps: Array<{ id: string }> }).connectedApps.map((profile) => profile.id), ["http-notes"]);
  const remoteInvoked = await remoteApi("/api/connected-apps/http-notes/invoke", remoteSession.session.token, {
    method: "POST", body: JSON.stringify({ method: "tools/list" }),
  });
  assert.equal(remoteInvoked.status, 200);
  assert.equal((await remoteApi("/api/connected-apps/not-selected/invoke", remoteSession.session.token, {
    method: "POST", body: JSON.stringify({ method: "tools/list" }),
  })).status, 403);
  assert.equal((await remoteApi("/api/experience/primary", remoteSession.session.token, {
    method: "PATCH", body: JSON.stringify({ expected_revision: envelope.revision, connected_app_ids: [] }),
  })).status, 403);
  assert.equal((await remoteApi("/api/device-sessions/current", remoteSession.session.token, { method: "DELETE" })).status, 200);

  const latest = await (await api("/api/experience/primary")).json() as typeof envelope;
  const deselected = await api("/api/experience/primary", {
    method: "PATCH", body: JSON.stringify({ expected_revision: latest.revision, connected_app_ids: [] }),
  });
  assert.equal(deselected.status, 200);

  const revoked = await api("/api/connected-apps/http-notes", { method: "DELETE" });
  assert.equal(revoked.status, 200);
  assert.deepEqual(await revoked.json(), { connectedAppId: "http-notes", revoked: true, upstreamStatus: 204 });
  assert.equal((await remoteApi("/api/connected-apps", "invalid")).status, 401);
});

test("a fresh session attach receives a durable transcript snapshot", async () => {
  db.prepare(`INSERT INTO projects (id, name, root_path, repo_path, test_command, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    "project-http", "HTTP project", "/tmp/http", "/tmp/http", "true", "2026-07-14T00:00:00.000Z",
  );
  db.prepare(`INSERT INTO sessions (id, project_id, title, created_at) VALUES (?, ?, ?, ?)`).run(
    "session-http", "project-http", "HTTP session", "2026-07-14T00:00:00.000Z",
  );
  db.prepare(`INSERT INTO runs (id, session_id, project_id, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    "run-http", "session-http", "project-http", "Snapshot", "running", "2026-07-14T00:00:00.000Z", "2026-07-14T00:00:00.000Z",
  );
  db.prepare(`INSERT INTO jobs (id, run_id, kind, status, idempotency_key, agent_spec_id, engine_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "job-http", "run-http", "builder", "running", "http-idempotency", "builder-default", "engine-session-http", "2026-07-14T00:00:00.000Z", "2026-07-14T00:00:00.000Z",
  );

  let envelope = await (await api("/api/experience/primary")).json() as { revision: number };
  const activated = await api("/api/experience/primary", {
    method: "PATCH",
    body: JSON.stringify({
      expected_revision: envelope.revision,
      active: { project_id: "project-http", session_id: "session-http", run_id: "run-http" },
      transcript_cursor: 0,
      last_event_id: null,
    }),
  });
  envelope = await activated.json() as { revision: number };
  synchronizePendingInteractions(db, "primary", envelope.revision, [{ id: "pending-question" }], [{ id: "pending-permission" }]);
  const preserved = await (await api("/api/experience/primary")).json() as { pending_questions: unknown[]; pending_permissions: unknown[] };
  assert.equal(preserved.pending_questions.length, 1);
  assert.equal(preserved.pending_permissions.length, 1);

  pendingProviderAvailable = true;
  pendingSnapshotHook = () => {
    db.prepare(`INSERT INTO jobs (id, run_id, kind, status, idempotency_key, agent_spec_id, engine_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "job-http-new", "run-http", "builder", "running", "http-idempotency-new", "builder-default", "engine-session-http-new", "2026-07-15T00:00:00.000Z", "2026-07-15T00:00:00.000Z",
    );
  };
  const rebound = await (await api("/api/experience/primary")).json() as { pending_questions: unknown[]; pending_permissions: unknown[] };
  assert.equal(rebound.pending_questions.length, 1);
  assert.equal(rebound.pending_permissions.length, 1);
  db.prepare(`INSERT INTO jobs (id, run_id, kind, status, idempotency_key, agent_spec_id, engine_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "job-http-reviewer", "run-http", "reviewer", "succeeded", "http-reviewer", "reviewer-default", "engine-session-reviewer", "2026-07-16T00:00:00.000Z", "2026-07-16T00:00:00.000Z",
  );
  db.prepare(`INSERT INTO runs (id, session_id, project_id, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    "run-http-other", "session-http", "project-http", "Other run", "running", "2026-07-17T00:00:00.000Z", "2026-07-17T00:00:00.000Z",
  );
  db.prepare(`INSERT INTO jobs (id, run_id, kind, status, idempotency_key, agent_spec_id, engine_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "job-http-other", "run-http-other", "builder", "running", "http-other", "builder-default", "engine-session-other", "2026-07-17T00:00:00.000Z", "2026-07-17T00:00:00.000Z",
  );
  pumpSessionChannel(db, {
    type: "message.part.text.delta",
    run_id: "run-http-other",
    job_id: "job-http-other",
    kind: "builder",
    engine_session_id: "engine-session-other",
    is_permission_ask: false,
    properties: { delta: "other run must stay isolated" },
  });
  messageSnapshotHook = () => {
    db.prepare(`INSERT INTO jobs (id, run_id, kind, status, idempotency_key, agent_spec_id, engine_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "job-http-replaced", "run-http", "builder", "running", "http-replaced", "builder-default", "engine-session-replaced", "2026-07-19T00:00:00.000Z", "2026-07-19T00:00:00.000Z",
    );
  };

  const controller = new AbortController();
  const response = await api("/api/sessions/session-http/attach", {
    method: "POST",
    body: JSON.stringify({ actor: "http-test", run_id: "run-http" }),
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  let text = "";
  try {
    for (let reads = 0; reads < 6 && (!text.includes("event: transcript") || !text.includes("duplicate live delta")); reads += 1) {
      const next = await reader.read();
      if (next.done) break;
      text += new TextDecoder().decode(next.value);
    }
    assert.match(text, /event: transcript/);
    assert.match(text, /"stream_epoch":"[0-9a-f-]{36}"/);
    assert.match(text, /"engine_session_id":"engine-session-replaced"/);
    assert.doesNotMatch(text, /"engine_session_id":"engine-session-http-new"/);
    assert.doesNotMatch(text, /engine-session-reviewer/);
    assert.doesNotMatch(text, /engine-session-other/);
    assert.doesNotMatch(text, /other run must stay isolated/);
    assert.match(text, /snapshot question/);
    assert.match(text, /snapshot answer/);
    assert.match(text, /duplicate live delta/);
    assert.match(text, /"replay_from_seq":0/);
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }

  pendingPermissionsResult = [{ id: "stale-permission" }];
  db.prepare(`UPDATE jobs SET updated_at = ? WHERE id = ?`).run("2026-07-18T00:00:00.000Z", "job-http-new");
  let releasePending!: () => void;
  pendingPermissionPause = new Promise<void>((resolve) => { releasePending = resolve; });
  const pendingEntered = new Promise<void>((resolve) => { pendingPermissionEntered = resolve; });
  const raceController = new AbortController();
  const raceResponse = await api("/api/sessions/session-http/attach", {
    method: "POST",
    body: JSON.stringify({ actor: "race-test" }),
    headers: { accept: "text/event-stream" },
    signal: raceController.signal,
  });
  const raceReader = raceResponse.body!.getReader();
  const firstRaceChunk = await raceReader.read();
  let raceText = new TextDecoder().decode(firstRaceChunk.value);
  await pendingEntered;
  const resolved = await api("/api/sessions/session-http/steer", {
    method: "POST",
    body: JSON.stringify({ type: "permission", request_id: "stale-permission", reply: "once", run_id: "run-http" }),
  });
  assert.equal(resolved.status, 202);
  releasePending();
  const nextRaceChunk = await Promise.race([
    raceReader.read(),
    new Promise<{ done: true; value?: Uint8Array }>((resolve) => setTimeout(() => resolve({ done: true }), 30)),
  ]);
  if (nextRaceChunk.value) raceText += new TextDecoder().decode(nextRaceChunk.value);
  assert.doesNotMatch(raceText, /stale-permission/);
  raceController.abort();
  await raceReader.cancel().catch(() => {});

  const readerEnrollment = await api("/api/devices/enroll", {
    method: "POST",
    body: JSON.stringify({
      device_id: "device-run-reader",
      metadata: { surface: "bounded-continuation" },
      allowed_scopes: ["health:read", "state:read", "experience:read", "experience:write", "run:read", "artifact:read"],
    }),
  });
  const readerDevice = await readerEnrollment.json() as { device_id: string; secret: string };
  const boundEnvelope = await (await api("/api/experience/primary")).json() as { revision: number };
  const readerIssue = await api("/api/handoffs", {
    method: "POST",
    body: JSON.stringify({ envelope_id: "primary", envelope_revision: boundEnvelope.revision }),
  });
  const readerHandoff = await readerIssue.json() as { token: string };
  const readerConsume = await remoteSelfAuthenticatedPost("/api/handoffs/consume", {
    token: readerHandoff.token,
    device_id: readerDevice.device_id,
    device_secret: readerDevice.secret,
  });
  const readerSession = await readerConsume.json() as { session: { token: string; scopes: string[] } };
  assert.equal(readerSession.session.scopes.includes("run:read"), true);
  assert.equal(readerSession.session.scopes.includes("artifact:read"), true);
  const lateArtifact = putArtifact(db, "created after handoff", "text/plain", "late artifact");
  linkRunArtifact(db, "run-http", "job-http", lateArtifact, "late");
  assert.equal((await remoteApi("/api/runs/run-http", readerSession.session.token)).status, 200);
  assert.equal((await remoteApi("/api/runs/run-http/artifact/late", readerSession.session.token)).status, 403);
  assert.equal((await remoteApi(`/api/artifacts/${lateArtifact}`, readerSession.session.token)).status, 403);
  const filteredState = await remoteApi("/api/state", readerSession.session.token);
  assert.equal(filteredState.status, 200);
  const filtered = await filteredState.json() as { projects: Array<{ id: string }>; sessions: Array<{ id: string }>; runs: Array<{ id: string }>; leases: unknown[] };
  assert.deepEqual(filtered.projects.map((item) => item.id), ["project-http"]);
  assert.deepEqual(filtered.sessions.map((item) => item.id), ["session-http"]);
  assert.deepEqual(filtered.runs.map((item) => item.id), ["run-http"]);
  assert.deepEqual(filtered.leases, []);
  const contextStreamResponse = await remoteApi("/api/experience/primary/stream", readerSession.session.token, {
    headers: { accept: "text/event-stream" },
  });
  const contextStreamReader = contextStreamResponse.body!.getReader();
  let initialContextStream = "";
  for (let reads = 0; reads < 4 && !initialContextStream.includes("event: experience"); reads += 1) {
    const chunk = await contextStreamReader.read();
    assert.equal(chunk.done, false);
    initialContextStream += new TextDecoder().decode(chunk.value);
  }
  assert.match(initialContextStream, /event: hello/);
  assert.match(initialContextStream, /event: experience/);
  const beforeMove = await (await api("/api/experience/primary")).json() as { revision: number };
  const remoteBeforeMove = await (await remoteApi("/api/experience/primary", readerSession.session.token)).json() as { revision: number };
  const remoteClear = await remoteApi("/api/experience/primary", readerSession.session.token, {
    method: "PATCH",
    body: JSON.stringify({ expected_revision: remoteBeforeMove.revision, active: { project_id: null, session_id: null, run_id: null } }),
  });
  assert.equal(remoteClear.status, 403);
  const afterDeniedClear = await (await api("/api/experience/primary")).json() as { revision: number; active: { run_id: string | null } };
  assert.equal(afterDeniedClear.revision, beforeMove.revision);
  assert.equal(afterDeniedClear.active.run_id, "run-http");
  const moveAway = await api("/api/experience/primary", {
    method: "PATCH",
    body: JSON.stringify({ expected_revision: beforeMove.revision, active: { project_id: null, session_id: null, run_id: null } }),
  });
  assert.equal(moveAway.status, 200);
  const snapshotStateResponse = await remoteApi("/api/state", readerSession.session.token);
  assert.equal(snapshotStateResponse.status, 200);
  const snapshotState = await snapshotStateResponse.json() as { experience: { active: { run_id: string } } };
  assert.equal(snapshotState.experience.active.run_id, "run-http");
  const snapshotEnvelopeResponse = await remoteApi("/api/experience/primary", readerSession.session.token);
  assert.equal(snapshotEnvelopeResponse.status, 200);
  const snapshotEnvelope = await snapshotEnvelopeResponse.json() as { revision: number; active: { run_id: string } };
  assert.equal(snapshotEnvelope.active.run_id, "run-http");
  const contextStreamStayedOpen = await Promise.race([
    contextStreamReader.read().then(() => false, () => false),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), 100)),
  ]);
  assert.equal(contextStreamStayedOpen, true);
  await contextStreamReader.cancel();
  const remoteDraft = await remoteApi("/api/experience/primary", readerSession.session.token, {
    method: "PATCH",
    body: JSON.stringify({ expected_revision: snapshotEnvelope.revision, composer_draft: "session-local continuation" }),
  });
  const remoteDraftText = await remoteDraft.text();
  assert.equal(remoteDraft.status, 200, remoteDraftText);
  const globalAfterRemoteDraft = await (await api("/api/experience/primary")).json() as { composer_draft: string };
  assert.notEqual(globalAfterRemoteDraft.composer_draft, "session-local continuation");
  const movedEnvelope = await moveAway.json() as { revision: number };
  const restoreBound = await api("/api/experience/primary", {
    method: "PATCH",
    body: JSON.stringify({ expected_revision: movedEnvelope.revision, active: { project_id: "project-http", session_id: "session-http", run_id: "run-http" } }),
  });
  assert.equal(restoreBound.status, 200);
});

test.after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => remoteServer.close((error) => error ? reject(error) : resolve()));
  db.close();
});
