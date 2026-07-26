import { createServer, request as requestHttp, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import type { Db } from "./db.ts";
import type { OpenCodeEngine } from "./engine.ts";
import {
  CORE_PORT,
  LOOPBACK,
  REMOTE_CORE_PORT,
  REMOTE_PUBLIC_ORIGIN,
  REMOTE_SURFACE_PUBLIC_PORTS,
  REMOTE_SURFACE_RELAY_PORTS,
  gatewayToken,
  nowIso,
  newId,
} from "./config.ts";
import { PATHS } from "./config.ts";
import { appendEvidence, listEvidence } from "./evidence.ts";
import { createRun, executeRun, decideRun, getRunDetail, readRunArtifact } from "./runs.ts";
import { getArtifact } from "./artifacts.ts";
import { recallMemory } from "./memory.ts";
import { listSkills, loadSkill, registerSkill } from "./skills.ts";
import { normalizeEngineEvent, type SessionMap } from "./live-channel.ts";
import { classifyEngineEvent, SessionBuffer } from "./session-channel.ts";
import { relayProviderRequest } from "./provider-gateway.ts";
import { ConnectorAuthorityError, ConnectorAuthorityService } from "./connector-authority.ts";
import { ConnectedAppAuthorityError, ConnectedAppAuthorityService } from "./connected-app-authority.ts";
import { ConnectedAppTransport, ConnectedAppTransportError } from "./connected-app-transport.ts";
import { renderQrSvg } from "./qr.ts";
import {
  ExperienceConflictError,
  getExperience,
  mergeExperienceSnapshot,
  negotiateExperience,
  registerSurface,
  synchronizePendingInteractions,
  updateExperience,
} from "./experience.ts";
import { ExperienceSecurityError, ExperienceSecurityService } from "./experience-security.ts";
import type {
  ExperienceDeviceSessionResources,
  ExperienceDeviceSessionScope,
  ExperienceEnvelope,
  ExperienceEnvelopePatch,
  ExperienceNegotiationRequest,
} from "@floyd/contracts";

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const COCKPIT_DIR = join(ROOT_DIR, "quarantine", "cockpit", "public");
const BROWSER_SDK = join(ROOT_DIR, "packages", "sdk", "browser", "floyd-sdk.js");
const SURFACE_MANIFEST = join(ROOT_DIR, "ecosystem", "surfaces.json");

type ReleaseIdentity = {
  source: "runtime-release" | "working-tree";
  source_commit: string | null;
  built_at: string | null;
  node_version: string;
};

function readReleaseIdentity(): ReleaseIdentity {
  try {
    const parsed = JSON.parse(readFileSync(join(ROOT_DIR, "release.json"), "utf8")) as Record<string, unknown>;
    if (typeof parsed.source_commit !== "string" || !/^[a-f0-9]{40}$/.test(parsed.source_commit)) {
      throw new Error("invalid release source commit");
    }
    return {
      source: "runtime-release",
      source_commit: parsed.source_commit,
      built_at: typeof parsed.built_at === "string" ? parsed.built_at : null,
      node_version: typeof parsed.node_version === "string" ? parsed.node_version : process.version,
    };
  } catch {
    return { source: "working-tree", source_commit: null, built_at: null, node_version: process.version };
  }
}

const RELEASE_IDENTITY = Object.freeze(readReleaseIdentity());

function admittedSurfaceCommit(id: string): string {
  const manifest = JSON.parse(readFileSync(SURFACE_MANIFEST, "utf8")) as {
    surfaces?: Array<{ id?: unknown; integration?: { commit?: unknown } }>;
  };
  const commit = manifest.surfaces?.find((surface) => surface.id === id)?.integration?.commit;
  if (typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error(`invalid admitted commit for ${id} in ${SURFACE_MANIFEST}`);
  }
  return commit;
}

const SURFACE_HEALTH_TIMEOUT_MS = 1_500;
const SURFACE_HEALTH_MAX_BYTES = 32 * 1024;
const ADMITTED_SURFACES = Object.freeze([
  {
    id: "desktop",
    target: "http://127.0.0.1:13010/",
    healthUrl: "http://127.0.0.1:13010/api/health",
    sourceRoot: "/Volumes/Storage/FLOYD_WORKSTATION/intake/surfaces/desktop",
    sourceCommit: admittedSurfaceCommit("desktop"),
    remoteRelayPort: REMOTE_SURFACE_RELAY_PORTS.desktop,
    remotePublicPort: REMOTE_SURFACE_PUBLIC_PORTS.desktop,
    launchPath: "/",
  },
  {
    id: "ide",
    target: "http://127.0.0.1:13012/",
    healthUrl: "http://127.0.0.1:13012/api/health",
    sourceRoot: "/Volumes/Storage/FLOYD_WORKSTATION/intake/surfaces/ide",
    sourceCommit: admittedSurfaceCommit("ide"),
    remoteRelayPort: REMOTE_SURFACE_RELAY_PORTS.ide,
    remotePublicPort: REMOTE_SURFACE_PUBLIC_PORTS.ide,
    launchPath: "/mwide/",
  },
  {
    id: "pty",
    target: "http://127.0.0.1:13013/",
    healthUrl: "http://127.0.0.1:13013/health",
    sourceRoot: "/Volumes/Storage/FLOYD_WORKSTATION/intake/surfaces/pty",
    sourceCommit: admittedSurfaceCommit("pty"),
    remoteRelayPort: REMOTE_SURFACE_RELAY_PORTS.pty,
    remotePublicPort: REMOTE_SURFACE_PUBLIC_PORTS.pty,
    launchPath: "/",
  },
  {
    id: "launcher",
    target: "http://127.0.0.1:13014/",
    healthUrl: "http://127.0.0.1:13014/health",
    sourceRoot: "/Volumes/Storage/FLOYD_WORKSTATION/intake/surfaces/launcher",
    sourceCommit: admittedSurfaceCommit("launcher"),
    remoteRelayPort: REMOTE_SURFACE_RELAY_PORTS.launcher,
    remotePublicPort: REMOTE_SURFACE_PUBLIC_PORTS.launcher,
    launchPath: "/",
  },
]);

type AdmittedSurface = (typeof ADMITTED_SURFACES)[number];

function remoteSurfaceOrigin(surface: AdmittedSurface): string {
  const origin = new URL(REMOTE_PUBLIC_ORIGIN);
  origin.port = String(surface.remotePublicPort);
  return origin.origin;
}

function remoteSurfaceTarget(surface: AdmittedSurface): string {
  return new URL(surface.launchPath, `${remoteSurfaceOrigin(surface)}/`).href;
}

type SurfaceHealthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type GatewayDependencies = {
  /** Test seam only. Callers cannot alter the fixed admitted URL registry. */
  surfaceHealthFetch?: SurfaceHealthFetch;
  /** Test seam for external OAuth discovery and token endpoints. */
  connectedAppFetch?: typeof globalThis.fetch;
};

async function boundedHealthJson(response: Response): Promise<Record<string, unknown>> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > SURFACE_HEALTH_MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("surface health response exceeds limit");
  }
  if (!response.body) throw new Error("surface health response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > SURFACE_HEALTH_MAX_BYTES) throw new Error("surface health response exceeds limit");
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("surface health response is not an object");
  return parsed as Record<string, unknown>;
}

async function probeAdmittedSurface(
  surface: (typeof ADMITTED_SURFACES)[number],
  fetchImpl: SurfaceHealthFetch,
  requestSignal: AbortSignal,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const relayAbort = () => controller.abort(requestSignal.reason ?? new Error("surface discovery client disconnected"));
  if (requestSignal.aborted) relayAbort();
  else requestSignal.addEventListener("abort", relayAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("surface health timeout")), SURFACE_HEALTH_TIMEOUT_MS);
  timeout.unref();
  try {
    const response = await fetchImpl(surface.healthUrl, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { id: surface.id, target: surface.target, verified: false, reason: `Health returned ${response.status}.` };
    }
    const health = await boundedHealthJson(response);
    const identity = health.identity;
    const verified = health.status === "ok"
      && Boolean(identity && typeof identity === "object" && !Array.isArray(identity))
      && (identity as Record<string, unknown>).surface_id === surface.id
      && (identity as Record<string, unknown>).source_root === surface.sourceRoot
      && (identity as Record<string, unknown>).source_commit === surface.sourceCommit;
    return verified
      ? { id: surface.id, target: surface.target, verified: true, reason: `Verified admitted copy ${surface.sourceCommit.slice(0, 8)}.` }
      : { id: surface.id, target: surface.target, verified: false, reason: "Health responded without the required admitted source identity." };
  } catch (error) {
    const reason = requestSignal.aborted
      ? "Surface discovery client disconnected."
      : controller.signal.aborted ? "Identity check timed out." : "Identity check failed.";
    return { id: surface.id, target: surface.target, verified: false, reason, error: error instanceof SyntaxError ? "invalid_json" : undefined };
  } finally {
    clearTimeout(timeout);
    requestSignal.removeEventListener("abort", relayAbort);
  }
}

async function discoverAdmittedSurfaces(fetchImpl: SurfaceHealthFetch, requestSignal: AbortSignal): Promise<Record<string, unknown>[]> {
  return Promise.all(ADMITTED_SURFACES.map((surface) => probeAdmittedSurface(surface, fetchImpl, requestSignal)));
}

type SseClient = { res: ServerResponse; run_id?: string };
const sseClients = new Set<SseClient>();

type ExperienceSseClient = { res: ServerResponse; envelope_id: string; principal: RemotePrincipal | null };
const experienceClients = new Set<ExperienceSseClient>();
type RemotePrincipal = ReturnType<ExperienceSecurityService["authenticateDeviceSession"]>;
const remoteStreams = new Map<string, Set<ServerResponse>>();
const remoteSurfaceSockets = new Map<string, Set<Duplex>>();
const remoteSurfaceRequests = new Map<string, Set<AbortController>>();
const connectedAppRequests = new Map<string, Set<AbortController>>();

function registerConnectedAppRequest(connectedAppId: string, signals: readonly AbortSignal[]): { signal: AbortSignal; finish: () => void } {
  const requests = connectedAppRequests.get(connectedAppId) ?? new Set<AbortController>();
  if (requests.size >= 8) throw new ExperienceSecurityError("scope_denied", "connected app request limit exceeded", 429);
  const controller = new AbortController();
  const relayAbort = (signal: AbortSignal) => controller.abort(signal.reason ?? new Error("connected app request aborted"));
  const listeners = signals.map((signal) => {
    const listener = () => relayAbort(signal);
    if (signal.aborted) listener();
    else signal.addEventListener("abort", listener, { once: true });
    return { signal, listener };
  });
  requests.add(controller);
  connectedAppRequests.set(connectedAppId, requests);
  let finished = false;
  return {
    signal: controller.signal,
    finish: () => {
      if (finished) return;
      finished = true;
      for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener);
      requests.delete(controller);
      if (requests.size === 0) connectedAppRequests.delete(connectedAppId);
    },
  };
}

function abortConnectedAppRequests(connectedAppId: string): void {
  for (const controller of connectedAppRequests.get(connectedAppId) ?? []) {
    controller.abort(new Error("connected app disconnected"));
  }
  connectedAppRequests.delete(connectedAppId);
}

function registerRemoteStream(res: ServerResponse, principal: RemotePrincipal): void {
  const current = remoteStreams.get(principal.sessionId) ?? new Set<ServerResponse>();
  current.add(res);
  remoteStreams.set(principal.sessionId, current);
  const delay = Math.max(1, Date.parse(principal.expiresAt) - Date.now());
  const expiry = setTimeout(() => res.destroy(new Error("device session expired")), delay);
  expiry.unref();
  res.on("close", () => {
    clearTimeout(expiry);
    current.delete(res);
    if (current.size === 0) remoteStreams.delete(principal.sessionId);
  });
}

function ensureRemoteStreamCapacity(principal: RemotePrincipal | null): void {
  if (principal && (remoteStreams.get(principal.sessionId)?.size ?? 0) >= 8) {
    throw new ExperienceSecurityError("scope_denied", "device session remote stream limit exceeded", 429);
  }
}

function closeRemoteStreams(sessionIds: readonly string[]): void {
  for (const sessionId of sessionIds) {
    for (const response of remoteStreams.get(sessionId) ?? []) response.destroy(new Error("device session revoked"));
    remoteStreams.delete(sessionId);
    for (const socket of remoteSurfaceSockets.get(sessionId) ?? []) socket.destroy(new Error("device session revoked"));
    remoteSurfaceSockets.delete(sessionId);
    for (const controller of remoteSurfaceRequests.get(sessionId) ?? []) controller.abort(new Error("device session revoked"));
    remoteSurfaceRequests.delete(sessionId);
  }
}

function registerRemoteSurfaceRequest(principal: RemotePrincipal): { controller: AbortController; finish: () => void } {
  const requests = remoteSurfaceRequests.get(principal.sessionId) ?? new Set<AbortController>();
  if (requests.size >= 16) throw new ExperienceSecurityError("scope_denied", "device session remote request limit exceeded", 429);
  const controller = new AbortController();
  requests.add(controller);
  remoteSurfaceRequests.set(principal.sessionId, requests);
  const expiry = setTimeout(() => controller.abort(new Error("device session expired")), Math.max(1, Date.parse(principal.expiresAt) - Date.now()));
  expiry.unref();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(expiry);
    requests.delete(controller);
    if (requests.size === 0) remoteSurfaceRequests.delete(principal.sessionId);
  };
  controller.signal.addEventListener("abort", finish, { once: true });
  return { controller, finish };
}

function registerRemoteSurfaceSocket(socket: Duplex, principal: RemotePrincipal): void {
  const sockets = remoteSurfaceSockets.get(principal.sessionId) ?? new Set<Duplex>();
  if (sockets.size >= 4) {
    throw new ExperienceSecurityError("scope_denied", "device session remote terminal limit exceeded", 429);
  }
  sockets.add(socket);
  remoteSurfaceSockets.set(principal.sessionId, sockets);
  const delay = Math.max(1, Date.parse(principal.expiresAt) - Date.now());
  const expiry = setTimeout(() => socket.destroy(new Error("device session expired")), delay);
  expiry.unref();
  socket.once("close", () => {
    clearTimeout(expiry);
    sockets.delete(socket);
    if (sockets.size === 0) remoteSurfaceSockets.delete(principal.sessionId);
  });
}

function sanitizeRemoteEnvelope(envelope: ExperienceEnvelope): Record<string, unknown> {
  const { credential_ref: _credentialRef, ...modelRoute } = envelope.model_route;
  return { ...envelope, model_route: { ...modelRoute, credential_ref: null } };
}

function sessionSnapshotEnvelope(principal: RemotePrincipal | null, envelopeId: string): ExperienceEnvelope | null {
  const value = principal?.snapshot?.envelope;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = value as ExperienceEnvelope;
  if (envelope.id !== envelopeId || !principal!.resources.envelope_ids.includes(envelopeId)) {
    throw new ExperienceSecurityError("handoff_invalid", "device session snapshot identity is invalid", 500);
  }
  requireRemoteEnvelopeContext(principal, envelope);
  return envelope;
}

function requireRemoteEnvelopeContext(principal: RemotePrincipal | null, envelope: ExperienceEnvelope): void {
  if (!principal) return;
  for (const [field, kind] of [
    ["project_id", "project_ids"],
    ["session_id", "session_ids"],
    ["run_id", "run_ids"],
  ] as const) {
    const current = envelope.active[field];
    const allowed = principal.resources[kind];
    if ((current === null && allowed.length !== 0) || (current !== null && !allowed.includes(current))) {
      throw new ExperienceSecurityError("scope_denied", "experience context moved outside the device session grant", 403);
    }
  }
  const selectedConnectedApps = envelope.connected_app_ids ?? [];
  if (selectedConnectedApps.length !== principal.resources.connected_app_ids.length
    || selectedConnectedApps.some((id) => !principal.resources.connected_app_ids.includes(id))) {
    throw new ExperienceSecurityError("scope_denied", "connected-application selection moved outside the device session grant", 403);
  }
}

function writeExperienceEvent(res: ServerResponse, envelope: ExperienceEnvelope, remote = false): boolean {
  try {
    const writable = res.write(`id: ${envelope.revision}\nevent: experience\ndata: ${JSON.stringify(remote ? sanitizeRemoteEnvelope(envelope) : envelope)}\n\n`);
    if (!writable) res.destroy(new Error("experience stream backpressure limit reached"));
    return writable;
  } catch {
    return false;
  }
}

function broadcastExperience(envelope: ExperienceEnvelope): void {
  for (const client of experienceClients) {
    if (client.envelope_id !== envelope.id) continue;
    // Paired handoffs own a session-local continuation snapshot. A global
    // workstation context change must not evict or overwrite that view.
    if (client.principal?.snapshot) continue;
    try {
      requireRemoteEnvelopeContext(client.principal, envelope);
    } catch {
      client.res.destroy(new Error("experience context moved outside the device session grant"));
      experienceClients.delete(client);
      continue;
    }
    if (!writeExperienceEvent(client.res, envelope, Boolean(client.principal))) experienceClients.delete(client);
  }
}

function broadcastSessionExperience(sessionId: string, envelope: ExperienceEnvelope): void {
  for (const client of experienceClients) {
    if (client.principal?.sessionId !== sessionId || client.envelope_id !== envelope.id) continue;
    if (!writeExperienceEvent(client.res, envelope, true)) experienceClients.delete(client);
  }
}

export function broadcast(event: string, data: unknown, runId?: string): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    if (runId && c.run_id && c.run_id !== runId) continue;
    if (!runId && c.run_id) continue; // run-scoped clients only get their run's events
    if (!writeRunEvent(c.res, msg)) sseClients.delete(c);
  }
}

/** Run/event streams are live-only; a slow reader is cut off instead of accumulating an unbounded buffer. */
export function writeRunEvent(res: Pick<ServerResponse, "write" | "destroy">, message: string): boolean {
  try {
    if (!res.write(message)) {
      res.destroy(new Error("run stream backpressure limit reached"));
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Engine-session → Floyd attribution, refreshed from the jobs table. */
export function loadSessionMap(db: Db): SessionMap {
  const rows = db
    .prepare(`SELECT engine_session_id, run_id, id, kind FROM jobs WHERE engine_session_id IS NOT NULL`)
    .all() as Array<Record<string, unknown>>;
  const map: SessionMap = new Map();
  for (const r of rows) {
    map.set(String(r.engine_session_id), { run_id: String(r.run_id), job_id: String(r.id), kind: String(r.kind) });
  }
  return map;
}

// ---------- bidirectional session channel (Objective 1) ----------

const sessionBuffer = new SessionBuffer(5000);
const sessionStreamEpoch = randomUUID();
type SessionSseClient = { res: ServerResponse; session_id: string; run_id?: string; buffer_key: string };
const sessionClients = new Set<SessionSseClient>();
const pendingInteractionVersions = new Map<string, number>();

function sessionBufferKey(sessionId: string, runId?: string): string {
  return runId ? `${sessionId}::${runId}` : `${sessionId}::*`;
}

function pendingInteractionVersion(sessionId: string, runId?: string): number {
  return pendingInteractionVersions.get(sessionBufferKey(sessionId, runId)) ?? 0;
}

function bumpPendingInteractionVersion(sessionId: string, runId: string): void {
  for (const key of [sessionBufferKey(sessionId, runId), sessionBufferKey(sessionId)]) {
    pendingInteractionVersions.set(key, (pendingInteractionVersions.get(key) ?? 0) + 1);
  }
}

function floydSessionOfRun(db: Db, runId: string): string | null {
  const r = db.prepare(`SELECT session_id FROM runs WHERE id = ?`).get(runId) as Record<string, unknown> | undefined;
  return r ? String(r.session_id) : null;
}

function writeSessionEvent(res: ServerResponse, seq: number, type: string, payload: unknown): boolean {
  try {
    if (!res.write(`id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)) {
      res.destroy();
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function writeSessionSnapshotEvent(res: ServerResponse, type: string, payload: unknown): boolean {
  try {
    if (!res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)) {
      res.destroy();
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Classify + sequence + fan out one attributed engine event to session subscribers. */
export function pumpSessionChannel(db: Db, out: ReturnType<typeof normalizeEngineEvent>): void {
  if (!out) return;
  const cls = classifyEngineEvent(out.type, out.properties);
  if (!cls) return;
  const floydSession = floydSessionOfRun(db, out.run_id);
  if (!floydSession) return;
  const payload = {
    type: cls.type,
    channel: cls.channel,
    run_id: out.run_id,
    job_id: out.job_id,
    kind: out.kind,
    engine_session_id: out.engine_session_id,
    engine_type: out.type,
    data: out.properties,
  };
  const aggregateSeq = sessionBuffer.append(sessionBufferKey(floydSession), { type: cls.type, payload });
  const runSeq = sessionBuffer.append(sessionBufferKey(floydSession, out.run_id), { type: cls.type, payload });
  for (const c of sessionClients) {
    if (c.session_id !== floydSession) continue;
    if (c.run_id && c.run_id !== out.run_id) continue;
    if (!writeSessionEvent(c.res, c.run_id ? runSeq : aggregateSeq, cls.type, payload)) sessionClients.delete(c);
  }
}

/**
 * Snapshot of interactive asks currently open on a Floyd session's active
 * engine session. A surface joining mid-run must see what's waiting for a human
 * even if the ask fired before it attached (cross-surface continuity).
 */
async function pendingAsksSnapshot(
  db: Db,
  engine: OpenCodeEngine,
  floydSessionId: string,
  runId?: string,
): Promise<{
  asks: Array<{ type: "permission" | "question"; payload: unknown }>;
  complete: boolean;
  engine_session_id: string | null;
  interaction_version: number;
}> {
  const interactionVersion = pendingInteractionVersion(floydSessionId, runId);
  const target = activeEngineSession(db, floydSessionId, runId);
  if (!target) return { asks: [], complete: true, engine_session_id: null, interaction_version: interactionVersion };
  const attribution = { run_id: target.run_id, job_id: target.job_id, kind: "builder", engine_session_id: target.engine_session_id };
  const out: Array<{ type: "permission" | "question"; payload: unknown }> = [];
  let complete = true;
  try {
    for (const p of await engine.pendingPermissions(target.engine_session_id)) {
      out.push({ type: "permission", payload: { type: "permission", ...attribution, engine_type: "snapshot.permission", data: p } });
    }
  } catch { complete = false; }
  try {
    const qs = (await engine.pendingQuestions(target.engine_session_id)) as Array<Record<string, unknown>>;
    for (const q of qs) {
      out.push({ type: "question", payload: { type: "question", ...attribution, engine_type: "snapshot.question", data: q } });
    }
  } catch { complete = false; }
  return { asks: out, complete, engine_session_id: target.engine_session_id, interaction_version: interactionVersion };
}

async function synchronizeEnvelopePendingForSession(db: Db, engine: OpenCodeEngine, sessionId: string, runId: string): Promise<void> {
  const snapshot = await pendingAsksSnapshot(db, engine, sessionId, runId);
  if (!snapshot.complete) return;
  if (pendingInteractionVersion(sessionId, runId) !== snapshot.interaction_version) return;
  const target = activeEngineSession(db, sessionId, runId);
  if (target?.engine_session_id !== snapshot.engine_session_id) return;
  const pendingQuestions = snapshot.asks.filter((ask) => ask.type === "question").map((ask) => ask.payload);
  const pendingPermissions = snapshot.asks.filter((ask) => ask.type === "permission").map((ask) => ask.payload);
  const rows = db.prepare(`SELECT id FROM experience_envelopes`).all() as Array<{ id: string }>;
  for (const row of rows) {
    let envelope = getExperience(db, row.id);
    if (envelope.active.session_id !== sessionId || envelope.active.run_id !== runId) continue;
    if (JSON.stringify(pendingQuestions) === JSON.stringify(envelope.pending_questions)
      && JSON.stringify(pendingPermissions) === JSON.stringify(envelope.pending_permissions)) continue;
    envelope = synchronizePendingInteractions(db, row.id, envelope.revision, pendingQuestions, pendingPermissions);
    broadcastExperience(envelope);
  }
}

/** Newest engine session able to receive steer/answers for a Floyd session. */
function activeEngineSession(db: Db, floydSessionId: string, runId?: string): { engine_session_id: string; job_id: string; run_id: string } | null {
  const row = runId
    ? db.prepare(
      `SELECT j.engine_session_id, j.id AS job_id, j.run_id FROM jobs j
       JOIN runs r ON r.id = j.run_id
       WHERE r.session_id = ? AND j.run_id = ? AND j.kind = 'builder' AND j.engine_session_id IS NOT NULL
       ORDER BY j.updated_at DESC LIMIT 1`,
    ).get(floydSessionId, runId) as Record<string, unknown> | undefined
    : db.prepare(
      `SELECT j.engine_session_id, j.id AS job_id, j.run_id FROM jobs j
       JOIN runs r ON r.id = j.run_id
       WHERE r.session_id = ? AND j.kind = 'builder' AND j.engine_session_id IS NOT NULL
       ORDER BY j.updated_at DESC LIMIT 1`,
    ).get(floydSessionId) as Record<string, unknown> | undefined;
  return row
    ? { engine_session_id: String(row.engine_session_id), job_id: String(row.job_id), run_id: String(row.run_id) }
    : null;
}

/** Wire the engine's /event stream into Floyd-attributed SSE broadcasts. */
export function startLiveChannel(db: Db, engine: OpenCodeEngine): { stop: () => void } {
  return engine.subscribeEvents((evt) => {
    const out = normalizeEngineEvent(evt, loadSessionMap(db));
    if (!out) return;
    broadcast("engine", out, out.run_id);
    pumpSessionChannel(db, out);
    const sessionId = floydSessionOfRun(db, out.run_id);
    if (sessionId && out.type.includes("asked") && (out.type.includes("question") || out.type.includes("permission"))) {
      bumpPendingInteractionVersion(sessionId, out.run_id);
      void synchronizeEnvelopePendingForSession(db, engine, sessionId, out.run_id).catch((error) => {
        appendEvidence(db, "experience.pending_sync_failed", "floyd-core", { error: String(error) }, { session_id: sessionId, run_id: out.run_id });
      });
    }
    if (out.is_permission_ask) {
      appendEvidence(db, "engine.permission_ask_observed", "floyd-core", { event: out.type, properties: out.properties }, {
        run_id: out.run_id,
        job_id: out.job_id,
      });
    }
  });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const ch of req) {
    const chunk = ch as Buffer;
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new RequestBodyTooLargeError();
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new RequestJsonError();
  }
}

class RequestJsonError extends Error {
  constructor() { super("request body is not valid JSON"); }
}

class RequestBodyTooLargeError extends Error {
  constructor() { super("request body exceeds 1048576 bytes"); }
}

function send(res: ServerResponse, code: number, body: unknown, mime = "application/json"): void {
  const out = mime === "application/json" ? JSON.stringify(body, null, 2) : String(body);
  res.writeHead(code, { "content-type": mime });
  res.end(out);
}

function requestObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ConnectorAuthorityError("invalid_input", "request body must be a JSON object", 400);
  }
  return body as Record<string, unknown>;
}

function requestAbortSignal(req: IncomingMessage, res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("client disconnected"));
  req.once("aborted", abort);
  res.once("close", abort);
  return controller.signal;
}

const DEVICE_SESSION_COOKIE = "__Host-floyd_session";
const LOCAL_SESSION_COOKIE = "floyd_local_session";
const LOCAL_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

type LocalSessionStore = Map<string, number>;

function localSessionDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function issueLocalSession(store: LocalSessionStore): { token: string; expiresAt: number } {
  const now = Date.now();
  for (const [digest, expiresAt] of store) {
    if (expiresAt <= now) store.delete(digest);
  }
  if (store.size >= 256) throw new Error("local session capacity exceeded");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = now + LOCAL_SESSION_TTL_MS;
  store.set(localSessionDigest(token), expiresAt);
  return { token, expiresAt };
}

function authenticateLocalSession(store: LocalSessionStore, token: string): boolean {
  if (!token) return false;
  const digest = localSessionDigest(token);
  const expiresAt = store.get(digest);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    store.delete(digest);
    return false;
  }
  return true;
}

function revokeLocalSession(store: LocalSessionStore, token: string): void {
  if (token) store.delete(localSessionDigest(token));
}

function cookieValue(req: IncomingMessage, name: string): string {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        // A malformed percent escape is attacker-controlled input. Treat it as
        // a missing credential so the normal authentication path returns 401.
        return "";
      }
    }
  }
  return "";
}

function setDeviceSessionCookie(res: ServerResponse, token: string, expiresAt: string): void {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  res.setHeader("set-cookie", `${DEVICE_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`);
}

function clearDeviceSessionCookie(res: ServerResponse): void {
  res.setHeader("set-cookie", `${DEVICE_SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`);
}

function setLocalSessionCookie(res: ServerResponse, token: string, expiresAt: number): void {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  // Core's local listener is plain HTTP by design, so Secure would make this
  // cookie unusable on 127.0.0.1. The listener is loopback-only and every
  // cookie-authenticated mutation is additionally origin-checked below.
  res.setHeader("set-cookie", `${LOCAL_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict`);
}

function clearLocalSessionCookie(res: ServerResponse): void {
  res.setHeader("set-cookie", `${LOCAL_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
}

function localRequestOrigin(req: IncomingMessage): string | null {
  const host = req.headers.host;
  if (!host) return null;
  try {
    const origin = new URL(`http://${host}`);
    return ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ? origin.origin : null;
  } catch {
    return null;
  }
}

function isSameOriginBrowserRequest(req: IncomingMessage, expectedOrigin: string | null): boolean {
  if (!expectedOrigin || req.headers.origin !== expectedOrigin) return false;
  const fetchSite = req.headers["sec-fetch-site"];
  return !fetchSite || fetchSite === "same-origin";
}

function remoteRouteScope(method: string | undefined, path: string): ExperienceDeviceSessionScope | null | undefined {
  if (method === "GET" && path === "/api/health") return "health:read";
  if (method === "GET" && path === "/api/state") return "state:read";
  if (method === "GET" && path === "/api/surfaces") return "surface:access";
  if (method === "GET" && path === "/api/evidence") return "evidence:read";
  if (method === "GET" && path === "/api/connected-apps") return "connected_app:read";
  if (method === "POST" && /^\/api\/connected-apps\/[^/]+\/invoke$/.test(path)) return "connected_app:invoke";
  if (method === "POST" && path === "/api/experience/negotiate") return "experience:write";
  if (/^\/api\/experience\/[^/]+$/.test(path)) return method === "GET" ? "experience:read" : method === "PATCH" ? "experience:write" : undefined;
  if (method === "GET" && /^\/api\/experience\/[^/]+\/stream$/.test(path)) return "experience:read";
  if (/^\/api\/sessions\/[^/]+\/(events|attach)$/.test(path)) return "session:read";
  if (method === "POST" && /^\/api\/sessions\/[^/]+\/steer$/.test(path)) return null;
  if (method === "GET" && /^\/api\/runs\/[^/]+\/artifact\/[^/]+$/.test(path)) return "artifact:read";
  if (method === "GET" && /^\/api\/runs\/[^/]+(?:\/stream)?$/.test(path)) return "run:read";
  if (method === "GET" && /^\/api\/artifacts\/[0-9a-f]{64}$/.test(path)) return "artifact:read";
  if (method === "DELETE" && path === "/api/device-sessions/current") return null;
  return undefined;
}

function requireRemoteResource(
  principal: RemotePrincipal | null,
  kind: keyof ExperienceDeviceSessionResources,
  id: string,
): void {
  if (principal && !principal.resources[kind].includes(id)) {
    throw new ExperienceSecurityError("scope_denied", `device session is not authorized for ${kind}`, 403);
  }
}

function requireRemoteScope(principal: RemotePrincipal | null, scope: ExperienceDeviceSessionScope): void {
  if (principal && !principal.scopes.includes(scope)) {
    throw new ExperienceSecurityError("scope_denied", `device session lacks ${scope}`, 403);
  }
}

function handoffResources(
  db: Db,
  envelopeId: string,
  envelopeRevision: number,
  snapshot: Record<string, unknown> | null,
): ExperienceDeviceSessionResources {
  const envelope = snapshot?.envelope as ExperienceEnvelope | undefined ?? getExperience(db, envelopeId);
  if (envelope.id !== envelopeId || Number(envelope.revision) !== envelopeRevision) {
    throw new ExperienceSecurityError("handoff_invalid", "handoff snapshot identity is invalid", 500);
  }
  if (snapshot) {
    const artifactIds = Array.isArray(snapshot.artifact_ids) ? snapshot.artifact_ids.map(String) : [];
    return {
      envelope_ids: [envelope.id],
      project_ids: envelope.active.project_id ? [envelope.active.project_id] : [],
      session_ids: envelope.active.session_id ? [envelope.active.session_id] : [],
      run_ids: envelope.active.run_id ? [envelope.active.run_id] : [],
      artifact_ids: artifactIds,
      connected_app_ids: envelope.connected_app_ids ?? [],
    };
  }
  if (Number(envelope.revision) !== envelopeRevision) {
    throw new ExperienceSecurityError(
      "handoff_stale",
      `handoff authorized ${envelopeId} revision ${envelopeRevision}, which is no longer current`,
      409,
    );
  }
  const artifactIds = envelope.active.run_id
    ? (db.prepare(`SELECT artifact_id FROM run_artifacts WHERE run_id = ?`).all(envelope.active.run_id) as Array<{ artifact_id: string }>).map((row) => row.artifact_id)
    : [];
  return {
    envelope_ids: [envelope.id],
    project_ids: envelope.active.project_id ? [envelope.active.project_id] : [],
    session_ids: envelope.active.session_id ? [envelope.active.session_id] : [],
    run_ids: envelope.active.run_id ? [envelope.active.run_id] : [],
    artifact_ids: artifactIds,
    connected_app_ids: envelope.connected_app_ids ?? [],
  };
}

function consumedHandoffEnvelope(db: Db, consumed: ReturnType<ExperienceSecurityService["consumeHandoffForDevice"]>): Record<string, unknown> {
  const snapshotEnvelope = consumed.handoff.snapshot?.envelope;
  return snapshotEnvelope && typeof snapshotEnvelope === "object" && !Array.isArray(snapshotEnvelope)
    ? snapshotEnvelope as Record<string, unknown>
    : sanitizeRemoteEnvelope(getExperience(db, consumed.handoff.envelopeId));
}

function validateRemoteExperiencePatch(
  rawPatch: Record<string, unknown>,
  principal: RemotePrincipal | null,
  currentEnvelope: ExperienceEnvelope,
): void {
  if (!principal) return;
  if ("model_route" in rawPatch) {
    throw new ExperienceSecurityError("scope_denied", "remote sessions cannot change model routing", 403);
  }
  if ("connected_app_ids" in rawPatch) {
    throw new ExperienceSecurityError("scope_denied", "remote sessions cannot change connected-application authority", 403);
  }
  if (rawPatch.selected_artifact_id !== undefined && rawPatch.selected_artifact_id !== null) {
    requireRemoteResource(principal, "artifact_ids", String(rawPatch.selected_artifact_id));
  }
  if (rawPatch.active !== undefined) {
    if (rawPatch.active === null || typeof rawPatch.active !== "object" || Array.isArray(rawPatch.active)) {
      throw new ExperienceSecurityError("invalid_input", "active context must be an object", 400);
    }
    const active = rawPatch.active as Record<string, unknown>;
    for (const [field, kind] of [
      ["project_id", "project_ids"],
      ["session_id", "session_ids"],
      ["run_id", "run_ids"],
    ] as const) {
      const value = active[field];
      if (value !== undefined && value !== null) requireRemoteResource(principal, kind, String(value));
    }
    requireRemoteEnvelopeContext(principal, {
      ...currentEnvelope,
      active: { ...currentEnvelope.active, ...active },
    } as ExperienceEnvelope);
  }
}

function deviceSessionResponse(session: ReturnType<ExperienceSecurityService["issueDeviceSession"]>): Record<string, unknown> {
  return {
    session_id: session.sessionId,
    device_id: session.deviceId,
    token: session.token,
    scopes: session.scopes,
    resources: session.resources,
    created_at: session.createdAt,
    expires_at: session.expiresAt,
  };
}

function createGateway(
  db: Db,
  engine: OpenCodeEngine,
  corePid: number,
  startedAt: string,
  boundary: "local" | "remote",
  dependencies: GatewayDependencies = {},
): ReturnType<typeof createServer> {
  const token = gatewayToken();
  const localSessions: LocalSessionStore = new Map();
  const selfAuthAttempts = new Map<string, { windowStarted: number; count: number }>();
  const experienceSecurity = new ExperienceSecurityService(db, {
    masterKeyPath: PATHS.experienceMasterKey,
    evidence: (event) => appendEvidence(db, event.type, event.actor, event.payload),
    sessionInvalidated: closeRemoteStreams,
  });
  const connectors = boundary === "local" ? new ConnectorAuthorityService(db, {
    masterKeyPath: PATHS.connectorMasterKey,
    evidence: (event) => appendEvidence(db, event.type, event.actor, event.payload),
  }) : null;
  const connectedApps = new ConnectedAppAuthorityService(db, {
    masterKeyPath: PATHS.connectedAppMasterKey,
    fetch: dependencies.connectedAppFetch,
    evidence: (event) => appendEvidence(db, event.type, event.actor, event.payload),
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${LOOPBACK}:${CORE_PORT}`);
    const path = url.pathname;
    const expectedLocalOrigin = boundary === "local" ? localRequestOrigin(req) : null;
    if (boundary === "local" && !expectedLocalOrigin) {
      return send(res, 421, { error: "local Core requires a loopback Host" });
    }
    if (boundary === "remote") {
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("x-frame-options", "DENY");
      res.setHeader("content-security-policy", "frame-ancestors 'none'");
      res.setHeader("strict-transport-security", "max-age=31536000");
    }

    // /gateway reserves Authorization and x-api-key for the upstream provider,
    // so local Core authentication uses a distinct header on that route.
    const isProviderGateway = path === "/gateway";
    if (isProviderGateway && req.headers.origin) {
      let allowedOrigin = "";
      try {
        const origin = new URL(req.headers.origin);
        if (["localhost", "127.0.0.1", "::1"].includes(origin.hostname)) allowedOrigin = origin.origin;
      } catch { /* malformed or opaque origin remains denied */ }
      if (!allowedOrigin) return send(res, 403, { error: "gateway CORS permits loopback origins only" });
      res.setHeader("access-control-allow-origin", allowedOrigin);
      res.setHeader("vary", "origin");
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type, authorization, x-api-key, anthropic-version, x-floyd-token, x-floyd-provider, x-floyd-base-url, x-floyd-credential-ref",
          "access-control-max-age": "600",
        });
        return res.end();
      }
    }
    const gatewayAuth = Array.isArray(req.headers["x-floyd-token"])
      ? req.headers["x-floyd-token"][0]
      : req.headers["x-floyd-token"];
    const bearerAuth = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    const deviceCookie = boundary === "remote" ? cookieValue(req, DEVICE_SESSION_COOKIE) : "";
    const localCookie = boundary === "local" ? cookieValue(req, LOCAL_SESSION_COOKIE) : "";
    const localSessionAuthenticated = boundary === "local" && authenticateLocalSession(localSessions, localCookie);
    const auth = isProviderGateway
      ? gatewayAuth || localCookie
      : bearerAuth || deviceCookie || localCookie;
    const isStatic = !path.startsWith("/api/") && !isProviderGateway;
    const localSessionBootstrap = boundary === "local" && path === "/api/local-session" && req.method === "POST";
    const connectedAppOAuthCallback = boundary === "local" && req.method === "GET"
      && path === "/api/connected-apps/oauth/callback";
    const selfAuthenticating = connectedAppOAuthCallback || localSessionBootstrap || (req.method === "POST"
      && (path === "/api/devices/authenticate" || path === "/api/handoffs/consume" || path === "/api/handoffs/pair"));
    if (selfAuthenticating) {
      if (path === "/api/handoffs/pair" && boundary === "remote" && !req.headers.origin) {
        return send(res, 403, { error: "browser pairing requires the configured remote Origin" });
      }
      if (req.headers.origin) {
        try {
          const origin = new URL(req.headers.origin);
          const loopbackOrigin = ["localhost", "127.0.0.1", "::1"].includes(origin.hostname);
          const exactRemoteOrigin = boundary === "remote" && origin.origin === REMOTE_PUBLIC_ORIGIN;
          const allowed = path === "/api/handoffs/pair" && boundary === "remote"
            ? exactRemoteOrigin
            : loopbackOrigin || exactRemoteOrigin;
          if (!allowed) return send(res, 403, { error: "self-authentication origin is not allowed" });
        } catch {
          return send(res, 403, { error: "self-authentication origin is invalid" });
        }
      }
      const now = Date.now();
      if (selfAuthAttempts.size > 1024) {
        for (const [attemptKey, value] of selfAuthAttempts) {
          if (now - value.windowStarted >= 60_000) selfAuthAttempts.delete(attemptKey);
        }
        if (selfAuthAttempts.size > 1024) return send(res, 503, { error: "self-authentication limiter capacity exceeded" });
      }
      const key = `${req.socket.remoteAddress ?? "unknown"}:${path}`;
      const prior = selfAuthAttempts.get(key);
      const attempt = !prior || now - prior.windowStarted >= 60_000
        ? { windowStarted: now, count: 1 }
        : { ...prior, count: prior.count + 1 };
      selfAuthAttempts.set(key, attempt);
      const limit = path === "/api/devices/authenticate" || path === "/api/local-session" ? 8 : path === "/api/handoffs/pair" ? 10 : 30;
      if (attempt.count > limit) return send(res, 429, { error: "self-authentication rate limit exceeded" });
    }
    let remotePrincipal: RemotePrincipal | null = null;
    if (boundary === "local") {
      const gatewayAuthenticated = isProviderGateway ? gatewayAuth === token : bearerAuth === token;
      if (!isStatic && !selfAuthenticating && !gatewayAuthenticated && !localSessionAuthenticated) {
        return send(res, 401, { error: "unauthorized: missing/invalid gateway token" });
      }
      if (!isStatic && !selfAuthenticating && !gatewayAuthenticated && localSessionAuthenticated
        && !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "")
        && !isSameOriginBrowserRequest(req, expectedLocalOrigin)) {
        return send(res, 403, { error: "cookie-authenticated mutation requires the exact loopback Origin" });
      }
    } else if (!isStatic && !selfAuthenticating) {
      if (isProviderGateway || gatewayAuth || !auth || auth === token) {
        return send(res, 401, { error: "remote boundary requires a device session" });
      }
      const requiredScope = remoteRouteScope(req.method, path);
      if (requiredScope === undefined) return send(res, 403, { error: "route is not exposed on the remote boundary" });
      try {
        remotePrincipal = experienceSecurity.authenticateDeviceSession(auth, requiredScope ?? undefined);
      } catch (error) {
        if (error instanceof ExperienceSecurityError) return send(res, error.httpStatus, { error: error.code, message: error.message });
        return send(res, 500, { error: "device session authentication failed" });
      }
      if (!bearerAuth && deviceCookie && !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "")) {
        if (req.headers.origin !== REMOTE_PUBLIC_ORIGIN) {
          return send(res, 403, { error: "cookie-authenticated mutation requires the configured remote Origin" });
        }
        if (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") {
          return send(res, 403, { error: "cookie-authenticated mutation requires a same-origin browser request" });
        }
      }
    }

    try {
      if (localSessionBootstrap) {
        res.setHeader("cache-control", "no-store");
        if (!isSameOriginBrowserRequest(req, expectedLocalOrigin)) {
          return send(res, 403, { error: "local session bootstrap requires the exact loopback Origin" });
        }
        if (bearerAuth !== token) return send(res, 401, { error: "invalid local session bootstrap" });
        let session;
        try { session = issueLocalSession(localSessions); }
        catch { return send(res, 503, { error: "local session capacity exceeded" }); }
        setLocalSessionCookie(res, session.token, session.expiresAt);
        return send(res, 201, { expires_at: new Date(session.expiresAt).toISOString() });
      }
      if (boundary === "local" && path === "/api/local-session" && req.method === "DELETE") {
        revokeLocalSession(localSessions, localCookie);
        clearLocalSessionCookie(res);
        res.setHeader("cache-control", "no-store");
        return send(res, 200, { revoked: true });
      }
      if (connectedAppOAuthCallback) {
        res.setHeader("cache-control", "no-store");
        res.setHeader("referrer-policy", "no-referrer");
        let location = "/?settings=connections";
        try {
          const state = url.searchParams.get("state") ?? "";
          const code = url.searchParams.get("code") ?? "";
          if (url.searchParams.has("error")) {
            throw new ConnectedAppAuthorityError("oauth_authorization_denied", "connected app authorization was denied", 400);
          }
          const credentialRef = await connectedApps!.completeOAuth(state, code, "oauth-callback", requestAbortSignal(req, res));
          const connectedAppId = credentialRef.slice("floyd-connected-app:".length);
          location += `&connected_app=${encodeURIComponent(connectedAppId)}`;
        } catch (error) {
          const code = error instanceof ConnectedAppAuthorityError ? error.code : "oauth_callback_failed";
          location += `&connection_error=${encodeURIComponent(code)}`;
        }
        res.writeHead(303, { location });
        return res.end();
      }
      if (isProviderGateway) {
        if (req.method !== "POST") return send(res, 405, { error: "gateway is POST" });
        const credentialRef = Array.isArray(req.headers["x-floyd-credential-ref"])
          ? req.headers["x-floyd-credential-ref"][0]
          : req.headers["x-floyd-credential-ref"];
        if (credentialRef && (req.headers.authorization || req.headers["x-api-key"])) {
          return send(res, 400, { error: "credential_ambiguous", message: "connector references cannot be combined with raw provider credentials" });
        }
        const credential = credentialRef ? await connectors!.resolve(credentialRef, requestAbortSignal(req, res)) : undefined;
        await relayProviderRequest(req, res, credential);
        return;
      }
      // ---------- API ----------
      if (path === "/api/health") {
        if (boundary === "remote") {
          return send(res, 200, {
            ok: true,
            service: "floyd-core",
            version: "0.1.0",
            now: nowIso(),
            release: RELEASE_IDENTITY,
            engine: { ok: await engine.isHealthy() },
          });
        }
        return send(res, 200, {
          ok: true,
          service: "floyd-core",
          version: "0.1.0",
          pid: corePid,
          started_at: startedAt,
          now: nowIso(),
          release: RELEASE_IDENTITY,
          engine: { ok: await engine.isHealthy(), url: engine.baseUrl, pid: engine.child?.pid ?? null },
        });
      }
      if (path === "/api/surfaces" && req.method === "GET") {
        res.setHeader("cache-control", "no-store");
        const surfaceHealthFetch = dependencies.surfaceHealthFetch ?? globalThis.fetch.bind(globalThis);
        const surfaces = await discoverAdmittedSurfaces(surfaceHealthFetch, requestAbortSignal(req, res));
        return send(res, 200, {
          surfaces: boundary === "remote"
            ? surfaces.map((result) => {
              const surface = ADMITTED_SURFACES.find((candidate) => candidate.id === result.id)!;
              return { ...result, target: remoteSurfaceTarget(surface) };
            })
            : surfaces,
        });
      }
      if (path === "/api/connectors" && req.method === "GET") {
        res.setHeader("cache-control", "no-store");
        return send(res, 200, { connectors: connectors!.profiles() });
      }
      if (path === "/api/connected-apps" && req.method === "GET") {
        res.setHeader("cache-control", "no-store");
        const profiles = connectedApps.profiles();
        return send(res, 200, {
          connectedApps: remotePrincipal
            ? profiles.filter((profile) => remotePrincipal!.resources.connected_app_ids.includes(profile.id))
            : profiles,
        });
      }
      if (path === "/api/connected-apps" && req.method === "POST") {
        res.setHeader("cache-control", "no-store");
        const body = requestObject(await readBody(req)) as unknown as Parameters<ConnectedAppAuthorityService["createProfile"]>[0];
        return send(res, 201, await connectedApps!.createProfile(body, "local-api", requestAbortSignal(req, res)));
      }
      const connectedAppOAuthStart = path.match(/^\/api\/connected-apps\/([^/]+)\/oauth\/start$/);
      if (connectedAppOAuthStart && req.method === "POST") {
        res.setHeader("cache-control", "no-store");
        const body = requestObject(await readBody(req));
        return send(res, 201, await connectedApps!.beginOAuth(
          decodeURIComponent(connectedAppOAuthStart[1]!),
          `http://${LOOPBACK}:${CORE_PORT}/api/connected-apps/oauth/callback`,
          body.ttlMs === undefined ? undefined : typeof body.ttlMs === "number" ? body.ttlMs : Number.NaN,
          "local-api",
          requestAbortSignal(req, res),
        ));
      }
      const connectedAppRefresh = path.match(/^\/api\/connected-apps\/([^/]+)\/refresh$/);
      if (connectedAppRefresh && req.method === "POST") {
        res.setHeader("cache-control", "no-store");
        return send(res, 200, await connectedApps!.refreshNow(
          decodeURIComponent(connectedAppRefresh[1]!), requestAbortSignal(req, res),
        ));
      }
      const connectedAppInvoke = path.match(/^\/api\/connected-apps\/([^/]+)\/invoke$/);
      if (connectedAppInvoke && req.method === "POST") {
        res.setHeader("cache-control", "no-store");
        const connectedAppId = decodeURIComponent(connectedAppInvoke[1]!);
        if (remotePrincipal) requireRemoteResource(remotePrincipal, "connected_app_ids", connectedAppId);
        else if (!getExperience(db).connected_app_ids.includes(connectedAppId)) {
          throw new ExperienceSecurityError("scope_denied", "connected app is not selected in the portable experience", 403);
        }
        const body = requestObject(await readBody(req));
        if (typeof body.method !== "string" || ["initialize", "notifications/initialized"].includes(body.method)) {
          throw new ConnectedAppTransportError("mcp_method_invalid", "connected app invocation method is invalid", null);
        }
        const clientSignal = requestAbortSignal(req, res);
        const remoteRequest = remotePrincipal ? registerRemoteSurfaceRequest(remotePrincipal) : null;
        const active = registerConnectedAppRequest(connectedAppId, [
          clientSignal,
          ...(remoteRequest ? [remoteRequest.controller.signal] : []),
        ]);
        let transport: ConnectedAppTransport | null = null;
        let result: Awaited<ReturnType<ConnectedAppTransport["call"]>> | null = null;
        try {
          const credential = await connectedApps.resolve(`floyd-connected-app:${connectedAppId}`, active.signal);
          transport = new ConnectedAppTransport(credential, { fetch: dependencies.connectedAppFetch });
          await transport.initialize({
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "Floyd Workstation", version: "0.1.0" },
          }, active.signal);
          result = await transport.call(body.method, body.params, active.signal);
        } finally {
          await transport?.close(AbortSignal.timeout(2_000)).catch((error) => {
            appendEvidence(db, "connected_app.transport_close_failed", "floyd-core", {
              connected_app_id: connectedAppId,
              error: error instanceof ConnectedAppTransportError ? error.code : "mcp_close_failed",
            });
          });
          active.finish();
          remoteRequest?.finish();
        }
        if (!result) throw new ConnectedAppTransportError("mcp_response_invalid", "connected app invocation returned no result", 502);
        return send(res, 200, { connectedAppId, status: result.status, messages: result.messages });
      }
      const connectedApp = path.match(/^\/api\/connected-apps\/([^/]+)$/);
      if (connectedApp && req.method === "DELETE") {
        res.setHeader("cache-control", "no-store");
        abortConnectedAppRequests(decodeURIComponent(connectedApp[1]!));
        return send(res, 200, await connectedApps!.revoke(
          decodeURIComponent(connectedApp[1]!), "local-api", requestAbortSignal(req, res),
        ));
      }
      if (path === "/api/connectors" && req.method === "POST") {
        res.setHeader("cache-control", "no-store");
        const body = requestObject(await readBody(req)) as Parameters<ConnectorAuthorityService["createProfile"]>[0];
        return send(res, 201, connectors!.createProfile(body, "local-api"));
      }
      const connectorApiKeyMatch = path.match(/^\/api\/connectors\/([^/]+)\/api-key$/);
      if (connectorApiKeyMatch && req.method === "POST") {
        res.setHeader("cache-control", "no-store");
        const body = requestObject(await readBody(req));
        const credentialRef = connectors!.storeApiKey(
          decodeURIComponent(connectorApiKeyMatch[1]!), typeof body.apiKey === "string" ? body.apiKey : "", "local-api",
        );
        return send(res, 201, { credentialRef });
      }
      const connectorOAuthStartMatch = path.match(/^\/api\/connectors\/([^/]+)\/oauth\/start$/);
      if (connectorOAuthStartMatch && req.method === "POST") {
        res.setHeader("cache-control", "no-store");
        const body = requestObject(await readBody(req));
        const result = connectors!.beginOAuth(
          decodeURIComponent(connectorOAuthStartMatch[1]!),
          typeof body.redirectUri === "string" ? body.redirectUri : "",
          body.ttlMs === undefined ? undefined : typeof body.ttlMs === "number" ? body.ttlMs : Number.NaN,
          "local-api",
        );
        return send(res, 201, result);
      }
      if (path === "/api/connectors/oauth/callback" && req.method === "POST") {
        res.setHeader("cache-control", "no-store");
        const body = requestObject(await readBody(req));
        const credentialRef = await connectors!.completeOAuth(
          typeof body.state === "string" ? body.state : "",
          typeof body.code === "string" ? body.code : "",
          "local-api", requestAbortSignal(req, res),
        );
        return send(res, 201, { credentialRef });
      }
      const connectorMatch = path.match(/^\/api\/connectors\/([^/]+)$/);
      if (connectorMatch && req.method === "DELETE") {
        res.setHeader("cache-control", "no-store");
        return send(res, 200, await connectors!.revoke(
          decodeURIComponent(connectorMatch[1]!), "local-api", requestAbortSignal(req, res),
        ));
      }
      if (path === "/api/state") {
        if (boundary === "remote") {
          const resources = remotePrincipal!.resources;
          const stateEnvelope = resources.envelope_ids.length
            ? sessionSnapshotEnvelope(remotePrincipal, resources.envelope_ids[0]!) ?? getExperience(db, resources.envelope_ids[0])
            : null;
          if (stateEnvelope) requireRemoteEnvelopeContext(remotePrincipal, stateEnvelope);
          const inList = (values: string[]) => values.length ? values : ["__none__"];
          const projectMarks = inList(resources.project_ids).map(() => "?").join(",");
          const sessionMarks = inList(resources.session_ids).map(() => "?").join(",");
          const runMarks = inList(resources.run_ids).map(() => "?").join(",");
          return send(res, 200, {
            projects: db.prepare(`SELECT id, name FROM projects WHERE id IN (${projectMarks})`).all(...inList(resources.project_ids)),
            sessions: db.prepare(`SELECT id, project_id, title, created_at FROM sessions WHERE id IN (${sessionMarks})`).all(...inList(resources.session_ids)),
            runs: db.prepare(`SELECT id, session_id, project_id, goal, status, created_at, updated_at FROM runs WHERE id IN (${runMarks})`).all(...inList(resources.run_ids)),
            jobs: db.prepare(`SELECT id, run_id, kind, status, created_at, updated_at FROM jobs WHERE run_id IN (${runMarks})`).all(...inList(resources.run_ids)),
            leases: [],
            provider_profiles: db.prepare(`SELECT id, vendor, billing_class, plan_name, region, approved FROM provider_profiles WHERE approved = 1`).all(),
            experience: stateEnvelope ? sanitizeRemoteEnvelope(stateEnvelope) : null,
          });
        }
        return send(res, 200, {
          projects: db.prepare(`SELECT * FROM projects`).all(),
          sessions: db.prepare(`SELECT * FROM sessions`).all(),
          runs: db.prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT 50`).all(),
          jobs: db.prepare(`SELECT id, run_id, kind, status, engine_session_id, worktree_lease_id, created_at, updated_at FROM jobs ORDER BY created_at DESC LIMIT 100`).all(),
          leases: db.prepare(`SELECT * FROM leases ORDER BY acquired_at DESC LIMIT 50`).all(),
          provider_profiles: db.prepare(`SELECT id, vendor, billing_class, plan_name, region, credential_ref, approved FROM provider_profiles`).all(),
          experience: getExperience(db),
        });
      }
      // ---------- portable cross-surface experience ----------
      if (path === "/api/experience/negotiate" && req.method === "POST") {
        const body = (await readBody(req)) as ExperienceNegotiationRequest & { envelope_id?: string; device_id?: string | null };
        if (body.device_id !== undefined) {
          return send(res, 400, { error: "device attribution requires a device-scoped session credential" });
        }
        const envelopeId = body.envelope_id ?? "primary";
        requireRemoteResource(remotePrincipal, "envelope_ids", envelopeId);
        const request: ExperienceNegotiationRequest = {
          surface_id: body.surface_id,
          sdk_version: body.sdk_version,
          supported_envelope_versions: body.supported_envelope_versions,
          capabilities: body.capabilities,
        };
        const snapshotEnvelope = sessionSnapshotEnvelope(remotePrincipal, envelopeId);
        if (remotePrincipal && snapshotEnvelope) {
          const negotiation = negotiateExperience(request);
          if (!negotiation.accepted) return send(res, 426, { error: "sdk_upgrade_required", ...negotiation });
          const existing = snapshotEnvelope.surfaces[request.surface_id];
          const next = mergeExperienceSnapshot(db, snapshotEnvelope, {
            expected_revision: snapshotEnvelope.revision,
            surface: {
              surface_id: request.surface_id,
              sdk_version: request.sdk_version,
              envelope_version: negotiation.envelope_version!,
              capabilities: request.capabilities,
              transcript_cursor: existing?.transcript_cursor ?? 0,
              transcript_epoch: existing?.transcript_epoch ?? snapshotEnvelope.transcript_epoch,
              last_event_id: existing?.last_event_id ?? null,
            },
            device_id: remotePrincipal.deviceId,
          });
          const nextSnapshot = { ...remotePrincipal.snapshot!, envelope: next };
          if (!experienceSecurity.replaceDeviceSessionSnapshot(remotePrincipal.sessionId, snapshotEnvelope.revision, nextSnapshot)) {
            return send(res, 409, { error: "revision_conflict", message: "device session snapshot changed concurrently" });
          }
          remotePrincipal.snapshot = nextSnapshot;
          appendEvidence(db, "experience.negotiation.accepted", `device:${remotePrincipal.deviceId}`, {
            envelope_id: envelopeId, sdk_version: request.sdk_version, envelope_version: negotiation.envelope_version,
          }, { project_id: next.active.project_id, session_id: next.active.session_id, run_id: next.active.run_id });
          broadcastSessionExperience(remotePrincipal.sessionId, next);
          return send(res, 200, negotiation);
        }
        let current = getExperience(db, envelopeId);
        requireRemoteEnvelopeContext(remotePrincipal, current);
        let result;
        try {
          result = registerSurface(db, envelopeId, { ...request, expected_revision: current.revision, device_id: remotePrincipal?.deviceId ?? null });
        } catch (error) {
          if (!(error instanceof ExperienceConflictError)) throw error;
          current = getExperience(db, envelopeId);
          requireRemoteEnvelopeContext(remotePrincipal, current);
          result = registerSurface(db, envelopeId, { ...request, expected_revision: current.revision, device_id: remotePrincipal?.deviceId ?? null });
        }
        if (!result.negotiation.accepted) {
          return send(res, 426, { error: "sdk_upgrade_required", ...result.negotiation });
        }
        broadcastExperience(result.envelope);
        return send(res, 200, result.negotiation);
      }
      const experienceMatch = path.match(/^\/api\/experience\/([^/]+)(?:\/(stream))?$/);
      if (experienceMatch) {
        const envelopeId = decodeURIComponent(experienceMatch[1] ?? "");
        requireRemoteResource(remotePrincipal, "envelope_ids", envelopeId);
        const authorizedEnvelope = sessionSnapshotEnvelope(remotePrincipal, envelopeId) ?? getExperience(db, envelopeId);
        requireRemoteEnvelopeContext(remotePrincipal, authorizedEnvelope);
        if (experienceMatch[2] === "stream") {
          if (req.method !== "GET") return send(res, 405, { error: "experience stream is GET" });
          const envelope = authorizedEnvelope;
          const lastRaw = req.headers["last-event-id"] ?? url.searchParams.get("lastEventId");
          const lastRevision = Number(Array.isArray(lastRaw) ? lastRaw[0] : lastRaw) || 0;
          ensureRemoteStreamCapacity(remotePrincipal);
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          if (remotePrincipal) registerRemoteStream(res, remotePrincipal);
          res.write(`event: hello\ndata: ${JSON.stringify({ envelope_id: envelopeId, revision: envelope.revision })}\n\n`);
          // A client can be ahead after Core restores an older durable snapshot.
          // Any unequal revision therefore receives authoritative current state.
          if (lastRevision !== envelope.revision && !writeExperienceEvent(res, envelope, Boolean(remotePrincipal))) return;
          const client = { res, envelope_id: envelopeId, principal: remotePrincipal };
          experienceClients.add(client);
          res.on("close", () => experienceClients.delete(client));
          return;
        }
        if (req.method === "GET") {
          let envelope = authorizedEnvelope;
          if (remotePrincipal) return send(res, 200, sanitizeRemoteEnvelope(envelope));
          const sessionId = envelope.active.session_id;
          const runId = envelope.active.run_id ?? undefined;
          const snapshot = sessionId
            ? await pendingAsksSnapshot(db, engine, sessionId, runId)
            : { asks: [], complete: true, engine_session_id: null, interaction_version: 0 };
          // Re-read after the provider calls: another surface may have changed
          // the active session or revision while the snapshot was in flight.
          envelope = getExperience(db, envelopeId);
          const currentTarget = sessionId ? activeEngineSession(db, sessionId, runId) : null;
          if (sessionId && snapshot.complete && envelope.active.session_id === sessionId
            && envelope.active.run_id === (runId ?? null)
            && pendingInteractionVersion(sessionId, runId) === snapshot.interaction_version
            && currentTarget?.engine_session_id === snapshot.engine_session_id) {
            const pendingQuestions = snapshot.asks.filter((ask) => ask.type === "question").map((ask) => ask.payload);
            const pendingPermissions = snapshot.asks.filter((ask) => ask.type === "permission").map((ask) => ask.payload);
            if (JSON.stringify(pendingQuestions) !== JSON.stringify(envelope.pending_questions)
              || JSON.stringify(pendingPermissions) !== JSON.stringify(envelope.pending_permissions)) {
              envelope = synchronizePendingInteractions(db, envelopeId, envelope.revision, pendingQuestions, pendingPermissions);
              broadcastExperience(envelope);
            }
          }
          return send(res, 200, envelope);
        }
        if (req.method === "PATCH") {
          const raw = await readBody(req);
          if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
            return send(res, 400, { error: "experience patch must be a JSON object" });
          }
          const rawPatch = raw as Record<string, unknown>;
          const currentAuthorizedEnvelope = authorizedEnvelope;
          requireRemoteEnvelopeContext(remotePrincipal, currentAuthorizedEnvelope);
          validateRemoteExperiencePatch(rawPatch, remotePrincipal, currentAuthorizedEnvelope);
          if ("pending_questions" in rawPatch || "pending_permissions" in rawPatch) {
            return send(res, 400, { error: "pending questions and permissions are Core-owned" });
          }
          if ("device_id" in rawPatch) {
            return send(res, 400, { error: "device attribution requires a device-scoped session credential" });
          }
          const patch = rawPatch as unknown as ExperienceEnvelopePatch;
          if (remotePrincipal?.snapshot) {
            try {
              const envelope = mergeExperienceSnapshot(db, currentAuthorizedEnvelope, {
                ...patch,
                device_id: remotePrincipal.deviceId,
              });
              const nextSnapshot = { ...remotePrincipal.snapshot, envelope };
              if (!experienceSecurity.replaceDeviceSessionSnapshot(remotePrincipal.sessionId, currentAuthorizedEnvelope.revision, nextSnapshot)) {
                const latest = experienceSecurity.getDeviceSessionSnapshot(remotePrincipal.sessionId);
                return send(res, 409, {
                  error: "revision_conflict",
                  expected_revision: patch.expected_revision,
                  actual_revision: (latest?.envelope as ExperienceEnvelope | undefined)?.revision ?? null,
                  envelope: latest?.envelope ?? null,
                });
              }
              remotePrincipal.snapshot = nextSnapshot;
              broadcastSessionExperience(remotePrincipal.sessionId, envelope);
              return send(res, 200, sanitizeRemoteEnvelope(envelope));
            } catch (error) {
              if (error instanceof ExperienceConflictError) {
                return send(res, 409, {
                  error: "revision_conflict",
                  expected_revision: patch.expected_revision,
                  actual_revision: currentAuthorizedEnvelope.revision,
                  envelope: sanitizeRemoteEnvelope(currentAuthorizedEnvelope),
                });
              }
              throw error;
            }
          }
          try {
            const envelope = updateExperience(db, envelopeId, patch, {
              actor: remotePrincipal ? `device:${remotePrincipal.deviceId}` : "surface:http",
              device_id: remotePrincipal?.deviceId ?? null,
            });
            broadcastExperience(envelope);
            return send(res, 200, remotePrincipal ? sanitizeRemoteEnvelope(envelope) : envelope);
          } catch (error) {
            if (error instanceof ExperienceConflictError) {
              const envelope = getExperience(db, envelopeId);
              requireRemoteEnvelopeContext(remotePrincipal, envelope);
              return send(res, 409, {
                error: "revision_conflict",
                expected_revision: patch.expected_revision,
                actual_revision: envelope.revision,
                envelope: remotePrincipal ? sanitizeRemoteEnvelope(envelope) : envelope,
              });
            }
            throw error;
          }
        }
        return send(res, 405, { error: "experience envelope supports GET and PATCH" });
      }
      // Device enrollment remains local Core-token protected. Authentication
      // and handoff consumption are the only self-authenticating routes on the
      // remote-safe listener, which must remain behind private HTTPS.
      if (path === "/api/devices/enroll" && req.method === "POST") {
        const body = (await readBody(req)) as { metadata?: Record<string, unknown>; device_id?: string; allowed_scopes?: ExperienceDeviceSessionScope[] };
        const enrolled = await experienceSecurity.enrollDevice(body.metadata ?? {}, body.device_id, body.allowed_scopes);
        return send(res, 201, {
          device_id: enrolled.deviceId,
          secret: enrolled.secret,
          created_at: enrolled.createdAt,
          key_id: enrolled.keyId,
        });
      }
      if (path === "/api/devices/authenticate" && req.method === "POST") {
        const body = (await readBody(req)) as { device_id?: string; secret?: string };
        if (!body.device_id || !body.secret) return send(res, 400, { error: "device_id and secret required" });
        const authenticated = await experienceSecurity.authenticateDevice(body.device_id, body.secret);
        const session = experienceSecurity.issueDeviceSession(authenticated.deviceId);
        res.setHeader("cache-control", "no-store");
        return send(res, 200, {
          device_id: authenticated.deviceId,
          metadata: authenticated.metadata,
          authenticated_at: authenticated.authenticatedAt,
          session: deviceSessionResponse(session),
        });
      }
      if (path === "/api/device-sessions/current" && req.method === "DELETE" && remotePrincipal) {
        clearDeviceSessionCookie(res);
        const revoked = experienceSecurity.revokeDeviceSession(remotePrincipal.sessionId, `device:${remotePrincipal.deviceId}`);
        if (revoked && experienceSecurity.isTransientDevice(remotePrincipal.deviceId)) {
          experienceSecurity.revokeDevice(remotePrincipal.deviceId, `device:${remotePrincipal.deviceId}`);
        }
        return revoked
          ? send(res, 200, { session_id: remotePrincipal.sessionId, revoked: true })
          : send(res, 404, { error: "no active device session" });
      }
      if (path.match(/^\/api\/devices\/[^/]+$/) && req.method === "DELETE") {
        const deviceId = decodeURIComponent(path.split("/")[3] ?? "");
        return experienceSecurity.revokeDevice(deviceId)
          ? send(res, 200, { device_id: deviceId, revoked: true })
          : send(res, 404, { error: "no active device" });
      }
      if (path === "/api/handoffs" && req.method === "POST") {
        const body = (await readBody(req)) as { envelope_id?: string; envelope_revision?: number; created_by_device_id?: string; ttl_ms?: number; scopes?: ExperienceDeviceSessionScope[] };
        const envelope = getExperience(db, body.envelope_id ?? "primary");
        const revision = body.envelope_revision ?? envelope.revision;
        if (revision !== envelope.revision) {
          return send(res, 409, { error: "revision_conflict", expected_revision: revision, actual_revision: envelope.revision, envelope });
        }
        const issued = experienceSecurity.issueHandoff({
          envelopeId: envelope.id,
          envelopeRevision: revision,
          createdByDeviceId: body.created_by_device_id,
          ttlMs: body.ttl_ms,
          scopes: body.scopes,
          snapshot: {
            envelope: sanitizeRemoteEnvelope(envelope),
            artifact_ids: envelope.active.run_id
              ? (db.prepare(`SELECT artifact_id FROM run_artifacts WHERE run_id = ?`).all(envelope.active.run_id) as Array<{ artifact_id: string }>).map((row) => row.artifact_id)
              : [],
          },
        });
        const fragment = new URLSearchParams({ handoff: issued.token });
        const deepLink = `${REMOTE_PUBLIC_ORIGIN.replace(/\/+$/, "")}/#${fragment.toString()}`;
        let qrSvg: string;
        try {
          qrSvg = await renderQrSvg(deepLink);
        } catch (error) {
          experienceSecurity.revokeHandoff(issued.handoffId, "qr-render-failed");
          throw error;
        }
        res.setHeader("cache-control", "no-store");
        return send(res, 201, {
          handoff_id: issued.handoffId,
          token: issued.token,
          envelope_id: issued.envelopeId,
          envelope_revision: issued.envelopeRevision,
          expires_at: issued.expiresAt,
          deep_link: deepLink,
          qr_svg: qrSvg,
          qr_content_type: "image/svg+xml",
        });
      }
      if (path === "/api/handoffs/consume" && req.method === "POST") {
        const body = (await readBody(req)) as { token?: string; device_id?: string; device_secret?: string };
        if (!body.token || !body.device_id || !body.device_secret) {
          return send(res, 400, { error: "token, device_id, and device_secret required" });
        }
        await experienceSecurity.authenticateDevice(body.device_id, body.device_secret);
        const consumed = experienceSecurity.consumeHandoffForDevice(
          body.token, body.device_id,
          (envelopeId, envelopeRevision, snapshot) => handoffResources(db, envelopeId, envelopeRevision, snapshot),
        );
        if (boundary === "remote") setDeviceSessionCookie(res, consumed.session.token, consumed.session.expiresAt);
        res.setHeader("cache-control", "no-store");
        return send(res, 200, {
          handoff_id: consumed.handoff.handoffId,
          envelope_id: consumed.handoff.envelopeId,
          envelope_revision: consumed.handoff.envelopeRevision,
          created_by_device_id: consumed.handoff.createdByDeviceId,
          consumed_at: consumed.handoff.consumedAt,
          envelope: consumedHandoffEnvelope(db, consumed),
          session: deviceSessionResponse(consumed.session),
        });
      }
      if (path === "/api/handoffs/pair" && req.method === "POST") {
        if (boundary !== "remote") return send(res, 403, { error: "pairing is available only on the private remote boundary" });
        const body = requestObject(await readBody(req));
        if (typeof body.token !== "string" || body.token.length === 0) return send(res, 400, { error: "token required" });
        const consumed = await experienceSecurity.pairHandoff(
          body.token,
          { surface: "browser", user_agent: String(req.headers["user-agent"] ?? "").slice(0, 512) },
          (envelopeId, envelopeRevision, snapshot) => handoffResources(db, envelopeId, envelopeRevision, snapshot),
        );
        setDeviceSessionCookie(res, consumed.session.token, consumed.session.expiresAt);
        res.setHeader("cache-control", "no-store");
        return send(res, 200, {
          handoff_id: consumed.handoff.handoffId,
          envelope_id: consumed.handoff.envelopeId,
          envelope_revision: consumed.handoff.envelopeRevision,
          consumed_at: consumed.handoff.consumedAt,
          envelope: consumedHandoffEnvelope(db, consumed),
          session: {
            session_id: consumed.session.sessionId,
            device_id: consumed.session.deviceId,
            scopes: consumed.session.scopes,
            resources: consumed.session.resources,
            created_at: consumed.session.createdAt,
            expires_at: consumed.session.expiresAt,
          },
        });
      }
      if (path.match(/^\/api\/handoffs\/[^/]+$/) && req.method === "DELETE") {
        const handoffId = decodeURIComponent(path.split("/")[3] ?? "");
        return experienceSecurity.revokeHandoff(handoffId)
          ? send(res, 200, { handoff_id: handoffId, revoked: true })
          : send(res, 404, { error: "no active handoff" });
      }
      if (path === "/api/skills" && req.method === "GET") {
        return send(res, 200, { skills: listSkills(db) });
      }
      if (path === "/api/skills" && req.method === "POST") {
        const b = (await readBody(req)) as { name?: string; version?: string; body?: string; permissions?: string[] };
        if (!b.name || !b.version || !b.body) return send(res, 400, { error: "name, version, body required" });
        return send(res, 201, registerSkill(db, { name: b.name, version: b.version, body: b.body, permissions: b.permissions ?? [] }));
      }
      if (path.startsWith("/api/skills/") && req.method === "GET") {
        const parts = path.split("/");
        const sk = loadSkill(db, parts[3] ?? "", parts[4]);
        return sk ? send(res, 200, sk) : send(res, 404, { error: "no such skill/version" });
      }
      if (path === "/api/memory") {
        const project_id = url.searchParams.get("project_id") ?? "";
        return send(res, 200, { items: recallMemory(db, project_id) });
      }
      if (path === "/api/evidence") {
        const run_id = url.searchParams.get("run_id") ?? undefined;
        if (remotePrincipal && !run_id) return send(res, 400, { error: "remote evidence requires run_id" });
        if (run_id) requireRemoteResource(remotePrincipal, "run_ids", run_id);
        return send(res, 200, { events: listEvidence(db, { run_id, limit: 500 }) });
      }
      // ---------- bidirectional session channel (Objective 1) ----------
      if (path.match(/^\/api\/sessions\/[^/]+\/(events|attach)$/)) {
        const sessionId = path.split("/")[3] ?? "";
        const isAttach = path.endsWith("/attach");
        if (isAttach && req.method !== "POST") return send(res, 405, { error: "attach is POST" });
        if (!isAttach && req.method !== "GET") return send(res, 405, { error: "events is GET" });
        requireRemoteResource(remotePrincipal, "session_ids", sessionId);
        if (!db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(sessionId)) {
          return send(res, 404, { error: "no such session" });
        }
        let actor = "anonymous";
        let runId = url.searchParams.get("run_id") ?? undefined;
        if (isAttach) {
          const body = (await readBody(req).catch(() => ({}))) as { actor?: string; run_id?: string };
          actor = remotePrincipal ? `device:${remotePrincipal.deviceId}` : body.actor ?? "anonymous";
          runId = body.run_id ?? runId;
        }
        if (remotePrincipal && !runId) return send(res, 400, { error: "remote session attach requires run_id" });
        if (runId) {
          requireRemoteResource(remotePrincipal, "run_ids", runId);
          const scopedRun = db.prepare(`SELECT id FROM runs WHERE id = ? AND session_id = ?`).get(runId, sessionId);
          if (!scopedRun) return send(res, 404, { error: "run does not belong to session" });
        }
        if (isAttach) {
          appendEvidence(db, "session.participant_attached", actor, { transport: "sse" }, { session_id: sessionId, run_id: runId });
        }
        const bufferKey = sessionBufferKey(sessionId, runId);
        // Resume replays the bounded run-scoped event buffer. A fresh attach
        // receives the durable provider transcript, then only events that
        // arrived while that transcript snapshot was in flight.
        const lastRaw = req.headers["last-event-id"] ?? url.searchParams.get("lastEventId");
        const hasResume = lastRaw !== undefined && lastRaw !== null;
        const lastSeq = hasResume ? Number(Array.isArray(lastRaw) ? lastRaw[0] : lastRaw) || 0 : sessionBuffer.lastSeq(bufferKey);
        ensureRemoteStreamCapacity(remotePrincipal);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        if (remotePrincipal) registerRemoteStream(res, remotePrincipal);
        let clientClosed = false;
        let client: SessionSseClient | null = null;
        res.on("close", () => {
          clientClosed = true;
          if (client) sessionClients.delete(client);
        });
        if (!writeSessionSnapshotEvent(res, "hello", {
          session_id: sessionId,
          run_id: runId ?? null,
          stream_epoch: sessionStreamEpoch,
          last_seq: sessionBuffer.lastSeq(bufferKey),
          replay_from: lastSeq,
        })) return;
        let transcriptEngineSessionId: string | null = null;
        if (isAttach && !hasResume) {
          // A fresh surface needs the durable conversation, not only events
          // emitted after it connected.
          let target = activeEngineSession(db, sessionId, runId);
          if (target) {
            let transcriptWritten = false;
            for (let attempt = 0; attempt < 2 && target && !transcriptWritten; attempt += 1) {
              const snapshotTarget: { engine_session_id: string; job_id: string; run_id: string } = target;
              try {
                const messages = await engine.messages(snapshotTarget.engine_session_id);
                if (clientClosed || res.destroyed) return;
                const currentTarget = activeEngineSession(db, sessionId, runId);
                if (currentTarget?.engine_session_id !== snapshotTarget.engine_session_id) {
                  target = currentTarget;
                  continue;
                }
                if (!writeSessionEvent(res, lastSeq, "transcript", {
                  session_id: sessionId,
                  engine_session_id: snapshotTarget.engine_session_id,
                  replay_from_seq: lastSeq,
                  messages,
                })) return;
                transcriptEngineSessionId = snapshotTarget.engine_session_id;
                transcriptWritten = true;
              } catch (error) {
                if (clientClosed || res.destroyed) return;
                const currentTarget = activeEngineSession(db, sessionId, runId);
                if (currentTarget?.engine_session_id !== snapshotTarget.engine_session_id && attempt === 0) {
                  target = currentTarget;
                  continue;
                }
                if (!writeSessionSnapshotEvent(res, "transcript", {
                  session_id: sessionId,
                  engine_session_id: snapshotTarget.engine_session_id,
                  messages: [],
                  unavailable: String(error),
                })) return;
                transcriptWritten = true;
              }
            }
            if (!transcriptWritten && !clientClosed && !res.destroyed) {
              if (!writeSessionSnapshotEvent(res, "transcript", {
                session_id: sessionId,
                engine_session_id: target?.engine_session_id ?? null,
                messages: [],
                unavailable: "builder changed repeatedly during transcript snapshot",
              })) return;
            }
          }
        }
        for (const e of sessionBuffer.since(bufferKey, lastSeq)) {
          const rec = e.event as { type: string; payload: unknown };
          const payloadEngineSessionId = typeof rec.payload === "object" && rec.payload && "engine_session_id" in rec.payload
            ? String(rec.payload.engine_session_id)
            : null;
          if (isAttach && !hasResume && transcriptEngineSessionId && payloadEngineSessionId
            && payloadEngineSessionId !== transcriptEngineSessionId) continue;
          if (!writeSessionEvent(res, e.seq, rec.type, rec.payload)) return;
        }
        if (clientClosed || res.destroyed) return;
        client = { res, session_id: sessionId, run_id: runId, buffer_key: bufferKey };
        sessionClients.add(client);
        // continuity: replay any interactive asks currently open, so a surface
        // that joined after the ask fired still sees what needs a human.
        void pendingAsksSnapshot(db, engine, sessionId, runId).then((snapshot) => {
          if (clientClosed || res.destroyed || !snapshot.complete) return;
          if (pendingInteractionVersion(sessionId, runId) !== snapshot.interaction_version) return;
          const currentTarget = activeEngineSession(db, sessionId, runId);
          if (currentTarget?.engine_session_id !== snapshot.engine_session_id) return;
          for (const a of snapshot.asks) {
            if (!writeSessionSnapshotEvent(res, a.type, a.payload)) break;
          }
        }).catch(() => {});
        return;
      }
      if (path.match(/^\/api\/sessions\/[^/]+\/steer$/) && req.method === "POST") {
        const sessionId = path.split("/")[3] ?? "";
        requireRemoteResource(remotePrincipal, "session_ids", sessionId);
        const body = (await readBody(req)) as {
          type?: "steer" | "answer" | "permission";
          text?: string;
          request_id?: string;
          answers?: string[][];
          reply?: "once" | "always" | "reject";
          actor?: string;
          run_id?: string;
        };
        if (remotePrincipal && !body.run_id) return send(res, 400, { error: "remote session input requires run_id" });
        if (body.run_id) requireRemoteResource(remotePrincipal, "run_ids", body.run_id);
        if (body.run_id && !db.prepare(`SELECT id FROM runs WHERE id = ? AND session_id = ?`).get(body.run_id, sessionId)) {
          return send(res, 404, { error: "run does not belong to session" });
        }
        const target = activeEngineSession(db, sessionId, body.run_id);
        if (!target) return send(res, 409, { error: "session has no engine session to receive input" });
        const actor = remotePrincipal ? `device:${remotePrincipal.deviceId}` : body.actor ?? "anonymous";
        if (body.type === "steer") {
          requireRemoteScope(remotePrincipal, "session:steer");
          if (!body.text) return send(res, 400, { error: "text required for steer" });
          await engine.steer(target.engine_session_id, body.text);
          appendEvidence(db, "engine.steer.submitted", actor, { chars: body.text.length, text: body.text.slice(0, 500) }, {
            session_id: sessionId, run_id: target.run_id, job_id: target.job_id,
          });
        } else if (body.type === "answer") {
          requireRemoteScope(remotePrincipal, "session:answer");
          if (!body.request_id) return send(res, 400, { error: "request_id required for answer" });
          const answers = body.answers ?? (body.text ? [[body.text]] : null);
          if (!answers) return send(res, 400, { error: "answers or text required" });
          try {
            await engine.replyQuestion(target.engine_session_id, body.request_id, answers);
          } catch (err) {
            return send(res, 410, { error: `question request not pending: ${String(err).slice(0, 120)}` });
          }
          bumpPendingInteractionVersion(sessionId, target.run_id);
          appendEvidence(db, "engine.question.answered", actor, { request_id: body.request_id }, {
            session_id: sessionId, run_id: target.run_id, job_id: target.job_id,
          });
          await synchronizeEnvelopePendingForSession(db, engine, sessionId, target.run_id);
        } else if (body.type === "permission") {
          requireRemoteScope(remotePrincipal, "session:permission");
          if (!body.request_id || !body.reply) return send(res, 400, { error: "request_id and reply required" });
          try {
            await engine.replyPermission(target.engine_session_id, body.request_id, body.reply);
          } catch (err) {
            return send(res, 410, { error: `permission request not pending (already decided or expired): ${String(err).slice(0, 120)}` });
          }
          bumpPendingInteractionVersion(sessionId, target.run_id);
          appendEvidence(db, "policy.decision", actor, { request_id: body.request_id, decision: body.reply, source: "surface" }, {
            session_id: sessionId, run_id: target.run_id, job_id: target.job_id,
          });
          await synchronizeEnvelopePendingForSession(db, engine, sessionId, target.run_id);
        } else {
          return send(res, 400, { error: "type must be steer | answer | permission" });
        }
        return send(res, 202, { session_id: sessionId, type: body.type, delivered_to: target.engine_session_id });
      }
      if (path.match(/^\/api\/runs\/[^/]+\/stream$/) && req.method === "GET") {
        const runId = path.split("/")[3] ?? "";
        requireRemoteResource(remotePrincipal, "run_ids", runId);
        if (!db.prepare(`SELECT id FROM runs WHERE id = ?`).get(runId)) return send(res, 404, { error: "no such run" });
        ensureRemoteStreamCapacity(remotePrincipal);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        if (remotePrincipal) registerRemoteStream(res, remotePrincipal);
        if (!writeRunEvent(res, `event: hello\ndata: ${JSON.stringify({ run_id: runId })}\n\n`)) return;
        const client = { res, run_id: runId };
        sseClients.add(client);
        res.on("close", () => sseClients.delete(client));
        return;
      }
      if (path.startsWith("/api/runs/") && req.method === "GET") {
        const parts = path.split("/");
        const runId = parts[3] ?? "";
        requireRemoteResource(remotePrincipal, "run_ids", runId);
        if (parts[4] === "artifact") {
          requireRemoteScope(remotePrincipal, "artifact:read");
          const role = parts[5] ?? "diff";
          if (remotePrincipal) {
            const linked = db.prepare(
              `SELECT artifact_id FROM run_artifacts WHERE run_id = ? AND role = ?`,
            ).get(runId, role) as { artifact_id: string } | undefined;
            if (!linked) return send(res, 404, { error: "no such artifact role" });
            requireRemoteResource(remotePrincipal, "artifact_ids", linked.artifact_id);
          }
          const content = readRunArtifact(db, runId, role);
          if (content === null) return send(res, 404, { error: "no such artifact role" });
          return send(res, 200, content, "text/plain; charset=utf-8");
        }
        const detail = getRunDetail(db, runId);
        return detail ? send(res, 200, detail) : send(res, 404, { error: "no such run" });
      }
      if (path === "/api/runs" && req.method === "POST") {
        const body = (await readBody(req)) as { project_id?: string; goal?: string };
        if (!body.project_id || !body.goal) return send(res, 400, { error: "project_id and goal required" });
        const created = createRun(db, body.project_id, body.goal);
        if (!created.duplicate) {
          broadcast("run", { run_id: created.run_id, status: "created" });
          // async execution; failures land in evidence + run status
          executeRun(db, engine, created.run_id)
            .then(() => broadcast("run", { run_id: created.run_id, status: "waiting_review" }))
            .catch((err) => {
              db.prepare(`UPDATE runs SET status='failed', updated_at=? WHERE id=?`).run(nowIso(), created.run_id);
              appendEvidence(db, "run.failed", "floyd-core", { error: String(err) }, { run_id: created.run_id });
              broadcast("run", { run_id: created.run_id, status: "failed" });
            });
        }
        return send(res, created.duplicate ? 200 : 202, created);
      }
      if (path.match(/^\/api\/runs\/[^/]+\/retry$/) && req.method === "POST") {
        const runId = path.split("/")[3] ?? "";
        const run = db.prepare(`SELECT status FROM runs WHERE id = ?`).get(runId) as Record<string, unknown> | undefined;
        if (!run) return send(res, 404, { error: "no such run" });
        if (!["created", "failed", "interrupted"].includes(String(run.status))) {
          return send(res, 409, { error: `run is ${String(run.status)}; retry only for created/failed/interrupted` });
        }
        appendEvidence(db, "run.retry", "floyd-core", { prior_status: run.status }, { run_id: runId });
        executeRun(db, engine, runId)
          .then(() => broadcast("run", { run_id: runId, status: "waiting_review" }))
          .catch((err) => {
            db.prepare(`UPDATE runs SET status='failed', updated_at=? WHERE id=?`).run(nowIso(), runId);
            appendEvidence(db, "run.failed", "floyd-core", { error: String(err) }, { run_id: runId });
            broadcast("run", { run_id: runId, status: "failed" });
          });
        return send(res, 202, { run_id: runId, retrying: true });
      }
      if (path.match(/^\/api\/runs\/[^/]+\/decision$/) && req.method === "POST") {
        const runId = path.split("/")[3] ?? "";
        const body = (await readBody(req)) as { action?: "accept" | "reject" | "escalate"; actor?: string };
        if (!body.action) return send(res, 400, { error: "action required" });
        const result = decideRun(db, engine, runId, body.action, body.actor ?? "douglas");
        broadcast("run", { run_id: runId, status: body.action });
        return send(res, 200, result);
      }
      if (path === "/api/projects" && req.method === "POST") {
        const body = (await readBody(req)) as { name?: string; root_path?: string; test_command?: string };
        if (!body.name || !body.root_path) return send(res, 400, { error: "name and root_path required" });
        const id = newId("prj");
        db.prepare(
          `INSERT INTO projects (id, name, root_path, repo_path, test_command, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(id, body.name, body.root_path, body.root_path, body.test_command ?? "node --test", nowIso());
        appendEvidence(db, "project.registered", "floyd-core", { name: body.name, root_path: body.root_path }, { project_id: id });
        return send(res, 201, { id });
      }
      if (path.startsWith("/api/artifacts/")) {
        const id = path.split("/")[3] ?? "";
        if (remotePrincipal) {
          requireRemoteResource(remotePrincipal, "artifact_ids", id);
          const linked = db.prepare(
            `SELECT run_id FROM run_artifacts WHERE artifact_id = ?`,
          ).all(id) as Array<{ run_id: string }>;
          if (!linked.some((row) => remotePrincipal!.resources.run_ids.includes(row.run_id))) {
            throw new ExperienceSecurityError("scope_denied", "device session is not authorized for artifact", 403);
          }
        }
        const art = getArtifact(db, id);
        if (!art) return send(res, 404, { error: "no such artifact" });
        return send(res, 200, art.content.toString("utf8"), String(art.meta.mime ?? "text/plain"));
      }
      if (path === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        if (!writeRunEvent(res, `event: hello\ndata: {"service":"floyd-core"}\n\n`)) return;
        const client = { res };
        sseClients.add(client);
        res.on("close", () => sseClients.delete(client));
        return;
      }
      if (path.match(/^\/api\/runs\/[^/]+\/steer$/) && req.method === "POST") {
        const runId = path.split("/")[3] ?? "";
        const body = (await readBody(req)) as { text?: string; actor?: string };
        if (!body.text) return send(res, 400, { error: "text required" });
        const builder = db
          .prepare(`SELECT id, engine_session_id, status FROM jobs WHERE run_id = ? AND kind = 'builder'`)
          .get(runId) as Record<string, unknown> | undefined;
        if (!builder?.engine_session_id) return send(res, 409, { error: "run has no active builder engine session" });
        await engine.steer(String(builder.engine_session_id), body.text);
        appendEvidence(db, "engine.steer.submitted", body.actor ?? "douglas", { chars: body.text.length, text: body.text.slice(0, 500) }, {
          run_id: runId,
          job_id: String(builder.id),
        });
        broadcast("engine", { type: "floyd.steer.submitted", run_id: runId, job_id: String(builder.id), kind: "builder", properties: { text: body.text } }, runId);
        return send(res, 202, { run_id: runId, steered: true });
      }

      // ---------- cockpit static ----------
      if (isStatic) {
        // Cockpit and its browser SDK are served directly from the active Core
        // checkout. Never let a long-lived developer tab resurrect an older UI
        // or continuity contract after Core has restarted on a new commit.
        res.setHeader("cache-control", "no-store");
        if (path === "/floyd-sdk.js") {
          return send(res, 200, readFileSync(BROWSER_SDK, "utf8"), "text/javascript; charset=utf-8");
        }
        const file = path === "/" ? "index.html" : path.slice(1);
        const full = join(COCKPIT_DIR, file);
        if (!full.startsWith(COCKPIT_DIR)) return send(res, 403, { error: "forbidden" });
        if (existsSync(full)) {
          const mime = file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".js") ? "text/javascript" : "text/plain";
          return send(res, 200, readFileSync(full, "utf8"), mime);
        }
        return send(res, 404, { error: "not found" });
      }
      return send(res, 404, { error: "not found" });
    } catch (err) {
      if (res.headersSent || res.destroyed) {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const status = err instanceof ExperienceSecurityError
        ? err.httpStatus
        : err instanceof ConnectorAuthorityError ? err.httpStatus
        : err instanceof ConnectedAppAuthorityError ? err.httpStatus
        : err instanceof ConnectedAppTransportError ? err.upstreamStatus ?? 502
        : err instanceof RequestJsonError ? 400
        : err instanceof RequestBodyTooLargeError ? 413
        : typeof err === "object" && err && "statusCode" in err ? Number(err.statusCode) : 500;
      const body = err instanceof ExperienceSecurityError
        ? { error: err.code, message: err.message }
        : err instanceof ConnectorAuthorityError
          ? err.upstream ?? { error: err.code, message: err.message }
        : err instanceof ConnectedAppAuthorityError
          ? err.upstream ?? { error: err.code, message: err.message }
        : err instanceof ConnectedAppTransportError
          ? err.upstream ?? { error: err.code, message: err.message }
        : err instanceof RequestJsonError ? { error: "invalid_json", message: err.message }
        : err instanceof RequestBodyTooLargeError ? { error: "payload_too_large", message: err.message }
        : { error: String(err) };
      return send(res, Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500, body);
    }
  });

  const transientCleanup = boundary === "remote" ? setInterval(() => {
    try { experienceSecurity.cleanupExpiredTransientDevices("expiry-sweeper"); }
    catch (error) { appendEvidence(db, "experience.transient_cleanup_failed", "floyd-core", { error: String(error) }); }
  }, 60_000) : null;
  transientCleanup?.unref();
  if (transientCleanup) server.once("close", () => clearInterval(transientCleanup));

  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.listen(boundary === "local" ? CORE_PORT : REMOTE_CORE_PORT, LOOPBACK);
  return server;
}

export function startGateway(
  db: Db,
  engine: OpenCodeEngine,
  corePid: number,
  startedAt: string,
  dependencies: GatewayDependencies = {},
): ReturnType<typeof createServer> {
  return createGateway(db, engine, corePid, startedAt, "local", dependencies);
}

export function startRemoteGateway(
  db: Db,
  engine: OpenCodeEngine,
  corePid: number,
  startedAt: string,
  dependencies: GatewayDependencies = {},
): ReturnType<typeof createServer> {
  return createGateway(db, engine, corePid, startedAt, "remote", dependencies);
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
]);
const PRIVATE_RELAY_HEADERS = new Set([
  "authorization", "cookie", "host", "origin", "referer", "x-api-key", "x-floyd-token", "x-forwarded-for", "x-forwarded-host",
  "x-forwarded-port", "x-forwarded-proto", "x-real-ip",
]);

type RemoteSurfaceGatewayDependencies = {
  /** Tests may replace fixed loopback ports without changing the production registry. */
  relayPorts?: Partial<Record<AdmittedSurface["id"], number>>;
  upstreamTargets?: Partial<Record<AdmittedSurface["id"], string>>;
  surfaceHealthFetch?: SurfaceHealthFetch;
};

function relayRequestHeaders(headers: IncomingHttpHeaders, upstream: URL): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || PRIVATE_RELAY_HEADERS.has(lower) || lower.startsWith("sec-websocket-")) continue;
    if (value !== undefined) forwarded[lower] = value;
  }
  forwarded.host = upstream.host;
  if (headers.origin) forwarded.origin = upstream.origin;
  return forwarded;
}

function relayResponseHeaders(headers: IncomingHttpHeaders, surface: AdmittedSurface, upstream: URL): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === "set-cookie" || lower === "x-frame-options" || lower === "content-security-policy") continue;
    if (lower === "location" && typeof value === "string") {
      try {
        const location = new URL(value, upstream);
        forwarded.location = location.origin === upstream.origin
          ? new URL(`${location.pathname}${location.search}${location.hash}`, `${remoteSurfaceOrigin(surface)}/`).href
          : value;
      } catch { forwarded.location = value; }
      continue;
    }
    if (value !== undefined) forwarded[lower] = value;
  }
  forwarded["content-security-policy"] = `frame-ancestors ${REMOTE_PUBLIC_ORIGIN}`;
  forwarded["referrer-policy"] = "no-referrer";
  forwarded["x-content-type-options"] = "nosniff";
  forwarded["strict-transport-security"] = "max-age=31536000";
  return forwarded;
}

function rawSocketResponse(socket: Duplex, status: number, message: string): void {
  const body = JSON.stringify({ error: message });
  socket.end(
    `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Bad Gateway"}\r\n`
    + "Content-Type: application/json\r\nConnection: close\r\n"
    + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function exactRelayOrigin(req: IncomingMessage, surface: AdmittedSurface): boolean {
  return req.headers.origin === remoteSurfaceOrigin(surface)
    && (!req.headers["sec-fetch-site"] || req.headers["sec-fetch-site"] === "same-origin");
}

/**
 * Start one loopback-only authenticated relay per admitted application. Tailscale
 * terminates HTTPS on the matching public ports; the host-only device cookie is
 * therefore shared without exposing a credential to JavaScript. Every request
 * is re-authenticated and every WebSocket is registered for expiry/revocation.
 */
export function startRemoteSurfaceGateways(
  db: Db,
  dependencies: RemoteSurfaceGatewayDependencies = {},
): Array<{ id: AdmittedSurface["id"]; server: ReturnType<typeof createServer>; relayPort: number; publicOrigin: string }> {
  const security = new ExperienceSecurityService(db, {
    masterKeyPath: PATHS.experienceMasterKey,
    evidence: (event) => appendEvidence(db, event.type, event.actor, event.payload),
    sessionInvalidated: closeRemoteStreams,
  });
  const healthFetch = dependencies.surfaceHealthFetch ?? globalThis.fetch.bind(globalThis);
  const verifiedUntil = new Map<AdmittedSurface["id"], number>();

  const verifySurface = async (surface: AdmittedSurface): Promise<void> => {
    if ((verifiedUntil.get(surface.id) ?? 0) > Date.now()) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("surface identity timeout")), SURFACE_HEALTH_TIMEOUT_MS);
    timeout.unref();
    try {
      const result = await probeAdmittedSurface(surface, healthFetch, controller.signal);
      if (result.verified !== true) throw new ExperienceSecurityError("scope_denied", String(result.reason), 503);
      verifiedUntil.set(surface.id, Date.now() + 1_000);
    } finally {
      clearTimeout(timeout);
    }
  };

  return ADMITTED_SURFACES.map((surface) => {
    const upstream = new URL(dependencies.upstreamTargets?.[surface.id] ?? surface.target);
    const relayPort = dependencies.relayPorts?.[surface.id] ?? surface.remoteRelayPort;
    const authenticate = (req: IncomingMessage): RemotePrincipal => {
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
      const credential = bearer || cookieValue(req, DEVICE_SESSION_COOKIE);
      if (!credential || credential === gatewayToken()) {
        throw new ExperienceSecurityError("device_session_invalid", "remote surface requires a device session", 401);
      }
      return security.authenticateDeviceSession(credential, "surface:access");
    };

    const server = createServer(async (req, res) => {
      let principal: RemotePrincipal;
      let lifecycle: ReturnType<typeof registerRemoteSurfaceRequest>;
      try {
        principal = authenticate(req);
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method ?? "") && !req.headers.authorization && !exactRelayOrigin(req, surface)) {
          throw new ExperienceSecurityError("scope_denied", "remote surface mutation requires its exact browser Origin", 403);
        }
        await verifySurface(surface);
        lifecycle = registerRemoteSurfaceRequest(principal);
      } catch (error) {
        const status = error instanceof ExperienceSecurityError ? error.httpStatus : 503;
        return send(res, status, {
          error: error instanceof ExperienceSecurityError ? error.code : "surface_unavailable",
          message: error instanceof Error ? error.message : String(error),
        });
      }

      const upstreamRequest = requestHttp({
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: relayRequestHeaders(req.headers, upstream),
      });
      let settled = false;
      lifecycle.controller.signal.addEventListener("abort", () => upstreamRequest.destroy(lifecycle.controller.signal.reason), { once: true });
      const abort = () => {
        if (!settled) lifecycle.controller.abort(new Error("remote surface client disconnected"));
      };
      req.once("aborted", abort);
      res.once("close", abort);
      upstreamRequest.once("response", (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode ?? 502, relayResponseHeaders(upstreamResponse.headers, surface, upstream));
        upstreamResponse.once("error", (error) => res.destroy(error));
        upstreamResponse.once("end", () => { settled = true; lifecycle.finish(); });
        upstreamResponse.pipe(res);
      });
      upstreamRequest.once("error", (error) => {
        settled = true;
        lifecycle.finish();
        if (!res.headersSent) send(res, 502, { error: "surface_upstream_failed", message: error.message });
        else res.destroy(error);
      });
      req.pipe(upstreamRequest);
    });

    server.on("upgrade", (req, socket, head) => {
      void (async () => {
        let principal: RemotePrincipal;
        try {
          principal = authenticate(req);
          if (!exactRelayOrigin(req, surface)) throw new ExperienceSecurityError("scope_denied", "remote WebSocket requires its exact browser Origin", 403);
          await verifySurface(surface);
          registerRemoteSurfaceSocket(socket, principal);
        } catch (error) {
          const status = error instanceof ExperienceSecurityError ? error.httpStatus : 503;
          rawSocketResponse(socket, status, error instanceof Error ? error.message : "surface unavailable");
          return;
        }

        const headers = relayRequestHeaders(req.headers, upstream);
        headers.connection = "Upgrade";
        headers.upgrade = req.headers.upgrade ?? "websocket";
        headers.origin = upstream.origin;
        for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"] as const) {
          if (req.headers[name] !== undefined) headers[name] = req.headers[name];
        }
        const upstreamRequest = requestHttp({
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port,
          method: "GET",
          path: req.url,
          headers,
        });
        upstreamRequest.once("upgrade", (response, upstreamSocket, upstreamHead) => {
          const lines = [`HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}`];
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            const name = response.rawHeaders[index]!;
            if (name.toLowerCase() === "set-cookie") continue;
            lines.push(`${name}: ${response.rawHeaders[index + 1] ?? ""}`);
          }
          socket.write(`${lines.join("\r\n")}\r\n\r\n`);
          if (upstreamHead.length) socket.write(upstreamHead);
          if (head.length) upstreamSocket.write(head);
          socket.once("error", () => upstreamSocket.destroy());
          upstreamSocket.once("error", () => socket.destroy());
          socket.once("close", () => upstreamSocket.destroy());
          upstreamSocket.once("close", () => socket.destroy());
          socket.pipe(upstreamSocket);
          upstreamSocket.pipe(socket);
        });
        upstreamRequest.once("response", (response) => {
          rawSocketResponse(socket, response.statusCode ?? 502, `surface WebSocket refused with ${response.statusCode ?? 502}`);
          response.resume();
        });
        upstreamRequest.once("error", (error) => socket.destroy(error));
        upstreamRequest.end();
      })();
    });

    server.headersTimeout = 10_000;
    server.requestTimeout = 0;
    server.keepAliveTimeout = 5_000;
    server.listen(relayPort, LOOPBACK);
    return { id: surface.id, server, relayPort, publicOrigin: remoteSurfaceOrigin(surface) };
  });
}
