import type { Db } from "./db.ts";
import { appendEvidence } from "./evidence.ts";
import { nowIso } from "./config.ts";
import {
  FLOYD_EXPERIENCE_VERSION,
  FLOYD_SDK_PROTOCOL_VERSION,
  type ExperienceEnvelope,
  type ExperienceEnvelopePatch,
  type ExperienceModelRoute,
  type ExperienceNegotiationRequest,
  type ExperienceNegotiationResult,
  type SurfaceExperienceState,
} from "@floyd/contracts";

export const DEFAULT_EXPERIENCE_ENVELOPE_ID = "primary";
export const MINIMUM_EXPERIENCE_SDK_VERSION = "0.1.0";

const MAX_ID_LENGTH = 256;
const MAX_STRING_LENGTH = 16_384;
const MAX_DRAFT_LENGTH = 262_144;
const MAX_INTERACTIONS = 1_000;
const MAX_INTERACTIONS_JSON_BYTES = 1_048_576;
const MAX_CONNECTED_APPS = 100;
const CONNECTED_APP_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ALLOWED_CREDENTIAL_REF_SCHEMES = new Set(["env", "keychain", "omp-auth-broker", "secret", "vault"]);

export class ExperienceValidationError extends Error {
  readonly statusCode = 400;
}

export class ExperienceNotFoundError extends Error {
  readonly statusCode = 404;
}

export class ExperienceConflictError extends Error {
  readonly statusCode = 409;

  constructor(id: string, expected: number, actual: number) {
    super(`experience envelope ${id} revision conflict: expected ${expected}, current ${actual}`);
  }
}

/**
 * Core-internal extension used to synchronize asks observed from the engine.
 * The public contract intentionally does not let ordinary surfaces author asks.
 */
export interface ExperienceEnvelopeMutation extends ExperienceEnvelopePatch {
  pending_questions?: unknown[];
  pending_permissions?: unknown[];
}

export interface ExperienceUpdateActor {
  actor?: string;
  device_id?: string | null;
}

export interface RegisterSurfaceInput extends ExperienceNegotiationRequest {
  expected_revision: number;
  device_id?: string | null;
}

interface ExperienceRow {
  id: string;
  schema_version: string;
  revision: number;
  payload_json: string;
  updated_at: string;
  updated_by_device_id: string | null;
}

function validation(message: string): never {
  throw new ExperienceValidationError(message);
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) validation(`${label} must be an object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) validation(`${label} must be a plain object`);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allow = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allow.has(key));
  if (unexpected) validation(`${label}.${unexpected} is not supported`);
}

function assertNullableString(value: unknown, label: string, max = MAX_STRING_LENGTH): asserts value is string | null {
  if (value !== null && (typeof value !== "string" || value.length > max)) {
    validation(`${label} must be null or a string no longer than ${max} characters`);
  }
}

function assertRequiredString(value: unknown, label: string, max = MAX_STRING_LENGTH): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    validation(`${label} must be a non-empty string no longer than ${max} characters`);
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) validation(`${label} must be a non-negative safe integer`);
}

function jsonClone<T>(value: T, label: string, maxBytes = MAX_INTERACTIONS_JSON_BYTES): T {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maxBytes) {
      return validation(`${label} exceeds the ${maxBytes} byte persistence limit`);
    }
    return JSON.parse(serialized) as T;
  } catch {
    return validation(`${label} must be JSON serializable`);
  }
}

function assertNoStructuredCredentials(value: unknown, path: string, ancestors = new Set<object>()): void {
  if (typeof value !== "object" || value === null) return;
  if (ancestors.has(value)) validation(`${path} must not contain cyclic objects`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertNoStructuredCredentials(value[index], `${path}[${index}]`, ancestors);
    ancestors.delete(value);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(x[_-]?api[_-]?key|api[_-]?key|provider[_-]?key|access[_-]?token|authorization|bearer|client[_-]?secret|credential|password|secret)$/i.test(key)) {
      validation(`${path}.${key} may not persist credential values`);
    }
    assertNoStructuredCredentials(child, `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

function validateCredentialRef(value: string | null): void {
  if (value === null) return;
  const match = /^([a-z][a-z0-9+.-]{1,63}):([A-Za-z0-9._/@-]{1,512})$/.exec(value);
  if (!match || !ALLOWED_CREDENTIAL_REF_SCHEMES.has(match[1] ?? "")) {
    validation("model_route.credential_ref must be a supported broker reference, never a credential value");
  }
}

function validateBaseUrl(value: string | null): void {
  if (value === null) return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return validation("model_route.base_url must be an absolute URL");
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    validation("model_route.base_url must use HTTPS (HTTP is allowed only on loopback)");
  }
  if (parsed.username || parsed.password) validation("model_route.base_url may not contain credentials");
}

function canonicalConnectedAppIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_CONNECTED_APPS) {
    validation(`connected_app_ids must be an array of at most ${MAX_CONNECTED_APPS} connected app IDs`);
  }
  const ids = value.map((id) => {
    if (typeof id !== "string" || !CONNECTED_APP_ID.test(id)) validation("connected_app_ids contains an invalid connected app ID");
    return id;
  });
  return [...new Set(ids)].sort();
}

function validateConnectedAppReferences(db: Db, ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`SELECT id FROM connected_app_profiles WHERE id IN (${placeholders})`).all(...ids) as Array<{ id: string }>;
  const existing = new Set(rows.map((row) => row.id));
  const missing = ids.find((id) => !existing.has(id));
  if (missing) validation(`connected_app_ids references connected app ${missing}, which does not exist`);
}

function parseSemver(value: string): [number, number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareSemver(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return (left[index] ?? 0) - (right[index] ?? 0);
  }
  return 0;
}

function validateNegotiationRequest(request: ExperienceNegotiationRequest): string | null {
  if (!request || typeof request !== "object" || Array.isArray(request)) return "negotiation request must be an object";
  const raw = request as unknown as Record<string, unknown>;
  const unexpected = Object.keys(raw).find((key) => !["surface_id", "sdk_version", "supported_envelope_versions", "capabilities"].includes(key));
  if (unexpected) return `negotiation request.${unexpected} is not supported`;
  if (typeof request.surface_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.surface_id)) {
    return "surface_id is invalid";
  }
  const sdk = typeof request.sdk_version === "string" ? parseSemver(request.sdk_version) : null;
  if (!sdk) return "sdk_version must be semantic version x.y.z";
  const minimum = parseSemver(MINIMUM_EXPERIENCE_SDK_VERSION) as [number, number, number];
  if (compareSemver(sdk, minimum) < 0) return `sdk ${request.sdk_version} is older than minimum ${MINIMUM_EXPERIENCE_SDK_VERSION}`;
  if (!Array.isArray(request.supported_envelope_versions)
    || request.supported_envelope_versions.length > 64
    || request.supported_envelope_versions.some((item) => typeof item !== "string" || item.length === 0 || item.length > 128)) {
    return "supported_envelope_versions must be a string array";
  }
  if (!request.supported_envelope_versions.includes(FLOYD_EXPERIENCE_VERSION)) {
    return `surface does not support envelope ${FLOYD_EXPERIENCE_VERSION}`;
  }
  if (!Array.isArray(request.capabilities) || request.capabilities.length > 256 || request.capabilities.some((item) => typeof item !== "string" || item.length === 0 || item.length > 128)) {
    return "capabilities must be an array of non-empty strings";
  }
  return null;
}

export function createDefaultExperienceEnvelope(id = DEFAULT_EXPERIENCE_ENVELOPE_ID): ExperienceEnvelope {
  assertRequiredString(id, "envelope id", MAX_ID_LENGTH);
  const updatedAt = nowIso();
  return {
    id,
    schema_version: FLOYD_EXPERIENCE_VERSION,
    revision: 0,
    active: { project_id: null, session_id: null, run_id: null },
    model_route: { provider: null, model: null, base_url: null, provider_profile_id: null, credential_ref: null },
    connected_app_ids: [],
    transcript_cursor: 0,
    transcript_epoch: null,
    last_event_id: null,
    pending_questions: [],
    pending_permissions: [],
    composer_draft: "",
    selected_artifact_id: null,
    selected_view: "cockpit",
    surfaces: {},
    updated_at: updatedAt,
    updated_by_device_id: null,
  };
}

function hydrate(row: ExperienceRow): ExperienceEnvelope {
  let payload: ExperienceEnvelope;
  try {
    payload = JSON.parse(row.payload_json) as ExperienceEnvelope;
  } catch {
    throw new Error(`experience envelope ${row.id} contains invalid JSON`);
  }
  return {
    ...payload,
    connected_app_ids: canonicalConnectedAppIds(payload.connected_app_ids ?? []),
    transcript_epoch: payload.transcript_epoch ?? null,
    surfaces: Object.fromEntries(Object.entries(payload.surfaces ?? {}).map(([surfaceId, surface]) => [
      surfaceId,
      { ...surface, transcript_epoch: surface.transcript_epoch ?? null },
    ])),
    id: row.id,
    schema_version: row.schema_version as typeof FLOYD_EXPERIENCE_VERSION,
    revision: Number(row.revision),
    updated_at: row.updated_at,
    updated_by_device_id: row.updated_by_device_id,
  };
}

export function getExperienceEnvelope(db: Db, id = DEFAULT_EXPERIENCE_ENVELOPE_ID): ExperienceEnvelope | null {
  const row = db.prepare(`SELECT * FROM experience_envelopes WHERE id = ?`).get(id) as unknown as ExperienceRow | undefined;
  if (!row) return null;
  if (row.schema_version !== FLOYD_EXPERIENCE_VERSION) {
    throw new Error(`experience envelope ${id} has unsupported schema ${row.schema_version}`);
  }
  return hydrate(row);
}

/** Stable HTTP/SDK integration name. A first read materializes the default. */
export function getExperience(db: Db, id = DEFAULT_EXPERIENCE_ENVELOPE_ID): ExperienceEnvelope {
  return ensureExperienceEnvelope(db, id);
}

export function ensureExperienceEnvelope(db: Db, id = DEFAULT_EXPERIENCE_ENVELOPE_ID): ExperienceEnvelope {
  const existing = getExperienceEnvelope(db, id);
  if (existing) return existing;
  const envelope = createDefaultExperienceEnvelope(id);
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare(
      `INSERT OR IGNORE INTO experience_envelopes
       (id, schema_version, revision, payload_json, updated_at, updated_by_device_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(envelope.id, envelope.schema_version, envelope.revision, JSON.stringify(envelope), envelope.updated_at, null);
    if (Number(result.changes) === 1) {
      appendEvidence(db, "experience.envelope.created", "floyd-core", {
        envelope_id: id,
        schema_version: FLOYD_EXPERIENCE_VERSION,
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const created = getExperienceEnvelope(db, id);
  if (!created) throw new Error(`experience envelope ${id} could not be created`);
  return created;
}

function validateActiveReferences(db: Db, active: ExperienceEnvelope["active"]): void {
  if (active.session_id !== null && active.project_id === null) validation("active.session_id requires active.project_id");
  if (active.run_id !== null && (active.session_id === null || active.project_id === null)) {
    validation("active.run_id requires active.session_id and active.project_id");
  }
  if (active.project_id !== null && !db.prepare(`SELECT id FROM projects WHERE id = ?`).get(active.project_id)) {
    validation(`active.project_id ${active.project_id} does not exist`);
  }
  if (active.session_id !== null) {
    const session = db.prepare(`SELECT project_id FROM sessions WHERE id = ?`).get(active.session_id) as { project_id: string } | undefined;
    if (!session) validation(`active.session_id ${active.session_id} does not exist`);
    if (session.project_id !== active.project_id) validation(`active.session_id ${active.session_id} does not belong to project ${active.project_id}`);
  }
  if (active.run_id !== null) {
    const run = db.prepare(`SELECT project_id, session_id FROM runs WHERE id = ?`).get(active.run_id) as { project_id: string; session_id: string } | undefined;
    if (!run) validation(`active.run_id ${active.run_id} does not exist`);
    if (run.project_id !== active.project_id || run.session_id !== active.session_id) {
      validation(`active.run_id ${active.run_id} does not belong to the active project and session`);
    }
  }
}

function validateModelRoute(db: Db, route: ExperienceModelRoute): void {
  for (const key of ["provider", "model", "base_url", "provider_profile_id", "credential_ref"] as const) {
    assertNullableString(route[key], `model_route.${key}`, key === "base_url" ? 2_048 : 512);
  }
  validateBaseUrl(route.base_url);
  validateCredentialRef(route.credential_ref);
  if (route.provider_profile_id !== null && !db.prepare(`SELECT id FROM provider_profiles WHERE id = ?`).get(route.provider_profile_id)) {
    validation(`model_route.provider_profile_id ${route.provider_profile_id} does not exist`);
  }
}

function validateSurface(surface: SurfaceExperienceState, previous?: SurfaceExperienceState, allowCursorReset = false): void {
  assertRequiredString(surface.surface_id, "surface.surface_id", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(surface.surface_id)) validation("surface.surface_id is invalid");
  if (!parseSemver(surface.sdk_version)) validation("surface.sdk_version must be semantic version x.y.z");
  const sdk = parseSemver(surface.sdk_version) as [number, number, number];
  const minimum = parseSemver(MINIMUM_EXPERIENCE_SDK_VERSION) as [number, number, number];
  if (compareSemver(sdk, minimum) < 0) validation(`surface SDK must be at least ${MINIMUM_EXPERIENCE_SDK_VERSION}`);
  if (surface.envelope_version !== FLOYD_EXPERIENCE_VERSION) validation(`surface must use envelope ${FLOYD_EXPERIENCE_VERSION}`);
  if (!Array.isArray(surface.capabilities) || surface.capabilities.length > 256) validation("surface.capabilities is invalid");
  for (const capability of surface.capabilities) assertRequiredString(capability, "surface capability", 128);
  assertNonNegativeInteger(surface.transcript_cursor, "surface.transcript_cursor");
  assertNullableString(surface.transcript_epoch, "surface.transcript_epoch", 128);
  const epochChanged = previous && surface.transcript_epoch !== previous.transcript_epoch;
  if (previous && !allowCursorReset && !epochChanged && surface.transcript_cursor < previous.transcript_cursor) {
    validation("surface.transcript_cursor may not move backwards");
  }
  assertNullableString(surface.last_event_id, "surface.last_event_id", 512);
}

function validatePatchShape(patch: ExperienceEnvelopeMutation): void {
  assertPlainObject(patch, "experience patch");
  assertOnlyKeys(patch as unknown as Record<string, unknown>, [
    "expected_revision", "active", "model_route", "connected_app_ids", "transcript_cursor", "transcript_epoch", "last_event_id", "pending_questions",
    "pending_permissions", "composer_draft", "selected_artifact_id", "selected_view", "surface", "device_id",
  ], "experience patch");
  assertNonNegativeInteger(patch.expected_revision, "expected_revision");
  if (patch.active !== undefined) {
    assertPlainObject(patch.active, "active");
    assertOnlyKeys(patch.active as Record<string, unknown>, ["project_id", "session_id", "run_id"], "active");
  }
  if (patch.model_route !== undefined) {
    assertPlainObject(patch.model_route, "model_route");
    assertOnlyKeys(patch.model_route as Record<string, unknown>, ["provider", "model", "base_url", "provider_profile_id", "credential_ref"], "model_route");
  }
  if (patch.surface !== undefined) {
    assertPlainObject(patch.surface, "surface");
    assertOnlyKeys(patch.surface as unknown as Record<string, unknown>, [
      "surface_id", "sdk_version", "envelope_version", "capabilities", "transcript_cursor", "transcript_epoch", "last_event_id",
    ], "surface");
    assertRequiredString(patch.surface.surface_id, "surface.surface_id", 128);
    assertRequiredString(patch.surface.sdk_version, "surface.sdk_version", 128);
    if (!Array.isArray(patch.surface.capabilities) || patch.surface.capabilities.length > 256) {
      validation("surface.capabilities is invalid");
    }
    for (const capability of patch.surface.capabilities) assertRequiredString(capability, "surface capability", 128);
    assertNonNegativeInteger(patch.surface.transcript_cursor, "surface.transcript_cursor");
    if (patch.surface.transcript_epoch !== undefined) {
      assertNullableString(patch.surface.transcript_epoch, "surface.transcript_epoch", 128);
    }
    assertNullableString(patch.surface.last_event_id, "surface.last_event_id", 512);
  }
  if (patch.pending_questions !== undefined) assertNoStructuredCredentials(patch.pending_questions, "pending_questions");
  if (patch.pending_permissions !== undefined) assertNoStructuredCredentials(patch.pending_permissions, "pending_permissions");
}

function mergePatch(db: Db, current: ExperienceEnvelope, patch: ExperienceEnvelopeMutation): ExperienceEnvelope {
  validatePatchShape(patch);
  if (patch.active) {
    for (const [key, value] of Object.entries(patch.active)) assertNullableString(value, `active.${key}`, MAX_ID_LENGTH);
  }
  const active = { ...current.active, ...patch.active };
  validateActiveReferences(db, active);
  const activeSessionChanged = active.session_id !== current.active.session_id;
  const activeRunChanged = active.run_id !== current.active.run_id;

  const modelRoute = { ...current.model_route, ...patch.model_route };
  validateModelRoute(db, modelRoute);

  const connectedAppIds = patch.connected_app_ids === undefined
    ? current.connected_app_ids
    : canonicalConnectedAppIds(patch.connected_app_ids);
  if (patch.connected_app_ids !== undefined) validateConnectedAppReferences(db, connectedAppIds);

  const transcriptEpoch = patch.transcript_epoch === undefined
    ? (activeSessionChanged ? null : current.transcript_epoch)
    : patch.transcript_epoch;
  assertNullableString(transcriptEpoch, "transcript_epoch", 128);
  const transcriptEpochChanged = transcriptEpoch !== current.transcript_epoch;
  const activeConversationChanged = activeSessionChanged || activeRunChanged;
  const cursorReset = activeConversationChanged || transcriptEpochChanged;
  const transcriptCursor = patch.transcript_cursor ?? (cursorReset ? 0 : current.transcript_cursor);
  assertNonNegativeInteger(transcriptCursor, "transcript_cursor");
  if (!cursorReset && transcriptCursor < current.transcript_cursor) validation("transcript_cursor may not move backwards");
  const lastEventId = patch.last_event_id === undefined ? (cursorReset ? null : current.last_event_id) : patch.last_event_id;
  assertNullableString(lastEventId, "last_event_id", 512);

  const composerDraft = patch.composer_draft ?? current.composer_draft;
  if (typeof composerDraft !== "string" || composerDraft.length > MAX_DRAFT_LENGTH) {
    validation(`composer_draft must be a string no longer than ${MAX_DRAFT_LENGTH} characters`);
  }
  const selectedArtifactId = patch.selected_artifact_id === undefined
    ? (activeConversationChanged ? null : current.selected_artifact_id)
    : patch.selected_artifact_id;
  assertNullableString(selectedArtifactId, "selected_artifact_id", MAX_ID_LENGTH);
  if (selectedArtifactId !== null) {
    if (active.run_id === null) validation("selected_artifact_id requires an active run");
    if (!db.prepare(`SELECT artifact_id FROM run_artifacts WHERE run_id = ? AND artifact_id = ?`).get(active.run_id, selectedArtifactId)) {
      validation(`selected_artifact_id ${selectedArtifactId} does not belong to active run ${active.run_id}`);
    }
  }
  const selectedView = patch.selected_view ?? current.selected_view;
  assertRequiredString(selectedView, "selected_view", 128);
  const deviceId = patch.device_id === undefined ? current.updated_by_device_id : patch.device_id;
  assertNullableString(deviceId, "device_id", MAX_ID_LENGTH);

  const pendingQuestions = patch.pending_questions === undefined
    ? (activeConversationChanged ? [] : current.pending_questions)
    : patch.pending_questions;
  const pendingPermissions = patch.pending_permissions === undefined
    ? (activeConversationChanged ? [] : current.pending_permissions)
    : patch.pending_permissions;
  if (!Array.isArray(pendingQuestions) || pendingQuestions.length > MAX_INTERACTIONS) validation("pending_questions is invalid");
  if (!Array.isArray(pendingPermissions) || pendingPermissions.length > MAX_INTERACTIONS) validation("pending_permissions is invalid");

  const surfaces = Object.fromEntries(Object.entries(current.surfaces).map(([surfaceId, surface]) => [
    surfaceId,
    cursorReset ? { ...surface, transcript_cursor: 0, transcript_epoch: transcriptEpoch, last_event_id: null } : surface,
  ]));
  if (patch.surface) {
    if (patch.surface.transcript_epoch !== undefined && patch.surface.transcript_epoch !== transcriptEpoch) {
      validation("surface.transcript_epoch must match transcript_epoch");
    }
    const surface: SurfaceExperienceState = {
      ...patch.surface,
      envelope_version: patch.surface.envelope_version ?? FLOYD_EXPERIENCE_VERSION,
      capabilities: [...new Set(patch.surface.capabilities)].sort(),
      transcript_epoch: patch.surface.transcript_epoch ?? transcriptEpoch,
      last_seen_at: nowIso(),
    };
    validateSurface(surface, current.surfaces[surface.surface_id], cursorReset);
    surfaces[surface.surface_id] = surface;
  }

  const updatedAt = nowIso();
  return {
    ...current,
    revision: current.revision + 1,
    active,
    model_route: modelRoute,
    connected_app_ids: connectedAppIds,
    transcript_cursor: transcriptCursor,
    transcript_epoch: transcriptEpoch,
    last_event_id: lastEventId,
    pending_questions: jsonClone(pendingQuestions, "pending_questions"),
    pending_permissions: jsonClone(pendingPermissions, "pending_permissions"),
    composer_draft: composerDraft,
    selected_artifact_id: selectedArtifactId,
    selected_view: selectedView,
    surfaces,
    updated_at: updatedAt,
    updated_by_device_id: deviceId,
  };
}

/**
 * Validate and merge an experience patch without writing the global envelope.
 * Handoff sessions use this to maintain their resource-bound continuation
 * snapshot after the workstation's primary envelope moves elsewhere.
 */
export function mergeExperienceSnapshot(
  db: Db,
  current: ExperienceEnvelope,
  patch: ExperienceEnvelopeMutation,
): ExperienceEnvelope {
  if (patch.expected_revision !== current.revision) {
    throw new ExperienceConflictError(current.id, patch.expected_revision, current.revision);
  }
  return mergePatch(db, current, patch);
}

export function updateExperienceEnvelope(
  db: Db,
  id: string,
  patch: ExperienceEnvelopeMutation,
  actor = "floyd-surface",
): ExperienceEnvelope {
  assertRequiredString(id, "envelope id", MAX_ID_LENGTH);
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = getExperienceEnvelope(db, id);
    if (!current) throw new ExperienceNotFoundError(`experience envelope ${id} does not exist`);
    if (current.revision !== patch.expected_revision) {
      throw new ExperienceConflictError(id, patch.expected_revision, current.revision);
    }
    const next = mergePatch(db, current, patch);
    const result = db.prepare(
      `UPDATE experience_envelopes
       SET revision = ?, payload_json = ?, updated_at = ?, updated_by_device_id = ?
       WHERE id = ? AND revision = ?`,
    ).run(next.revision, JSON.stringify(next), next.updated_at, next.updated_by_device_id, id, patch.expected_revision);
    if (Number(result.changes) !== 1) {
      const latest = getExperienceEnvelope(db, id);
      throw new ExperienceConflictError(id, patch.expected_revision, latest?.revision ?? -1);
    }
    const changedFields = Object.keys(patch).filter((key) => !["expected_revision", "device_id"].includes(key)).sort();
    appendEvidence(db, "experience.envelope.updated", actor, {
      envelope_id: id,
      revision: next.revision,
      changed_fields: changedFields,
      surface_id: patch.surface?.surface_id ?? null,
    }, {
      project_id: next.active.project_id,
      session_id: next.active.session_id,
      run_id: next.active.run_id,
    });
    db.exec("COMMIT");
    return next;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Stable integration wrapper; device identity is data, while actor labels audit evidence. */
export function updateExperience(
  db: Db,
  id: string,
  patch: ExperienceEnvelopeMutation,
  actorOrDevice: string | ExperienceUpdateActor = "floyd-surface",
): ExperienceEnvelope {
  const actor = typeof actorOrDevice === "string" ? actorOrDevice : actorOrDevice.actor ?? "floyd-surface";
  const mutation = typeof actorOrDevice === "string" || actorOrDevice.device_id === undefined
    ? patch
    : { ...patch, device_id: actorOrDevice.device_id };
  return updateExperienceEnvelope(db, id, mutation, actor);
}

export function registerExperienceSurface(
  db: Db,
  id: string,
  expectedRevision: number,
  surface: ExperienceEnvelopePatch["surface"] & {},
  deviceId: string | null = null,
): ExperienceEnvelope {
  return updateExperienceEnvelope(db, id, {
    expected_revision: expectedRevision,
    surface,
    device_id: deviceId,
  }, `surface:${surface.surface_id}`);
}

export function synchronizePendingInteractions(
  db: Db,
  id: string,
  expectedRevision: number,
  pendingQuestions: unknown[],
  pendingPermissions: unknown[],
): ExperienceEnvelope {
  return updateExperienceEnvelope(db, id, {
    expected_revision: expectedRevision,
    pending_questions: pendingQuestions,
    pending_permissions: pendingPermissions,
  }, "floyd-core");
}

export function negotiateExperience(request: ExperienceNegotiationRequest): ExperienceNegotiationResult {
  const reason = validateNegotiationRequest(request);
  return reason ? {
    accepted: false,
    envelope_version: null,
    core_protocol_version: FLOYD_SDK_PROTOCOL_VERSION,
    minimum_sdk_version: MINIMUM_EXPERIENCE_SDK_VERSION,
    reason,
  } : {
    accepted: true,
    envelope_version: FLOYD_EXPERIENCE_VERSION,
    core_protocol_version: FLOYD_SDK_PROTOCOL_VERSION,
    minimum_sdk_version: MINIMUM_EXPERIENCE_SDK_VERSION,
  };
}

export function negotiateAndRegisterSurface(
  db: Db,
  id: string,
  request: ExperienceNegotiationRequest,
  expectedRevision: number,
  deviceId: string | null = null,
): { negotiation: ExperienceNegotiationResult; envelope: ExperienceEnvelope } {
  const negotiation = negotiateExperience(request);
  if (!negotiation.accepted) {
    const envelope = ensureExperienceEnvelope(db, id);
    appendEvidence(db, "experience.negotiation.rejected", `surface:${request.surface_id || "unknown"}`, {
      envelope_id: id,
      sdk_version: request.sdk_version,
      supported_envelope_versions: request.supported_envelope_versions,
      reason: negotiation.reason,
    }, {
      project_id: envelope.active.project_id,
      session_id: envelope.active.session_id,
      run_id: envelope.active.run_id,
    });
    return { negotiation, envelope };
  }
  const current = getExperience(db, id);
  const existingSurface = current.surfaces[request.surface_id];
  const envelope = registerExperienceSurface(db, id, expectedRevision, {
    surface_id: request.surface_id,
    sdk_version: request.sdk_version,
    envelope_version: negotiation.envelope_version ?? FLOYD_EXPERIENCE_VERSION,
    capabilities: request.capabilities,
    // Renegotiation is a capability/version handshake, not a replay reset.
    // Preserve the surface's resume point so reconnecting cannot lose position.
    transcript_cursor: existingSurface?.transcript_cursor ?? 0,
    transcript_epoch: existingSurface?.transcript_epoch ?? current.transcript_epoch,
    last_event_id: existingSurface?.last_event_id ?? null,
  }, deviceId);
  appendEvidence(db, "experience.negotiation.accepted", `surface:${request.surface_id}`, {
    envelope_id: id,
    sdk_version: request.sdk_version,
    envelope_version: negotiation.envelope_version,
    capabilities: [...new Set(request.capabilities)].sort(),
  }, {
    project_id: envelope.active.project_id,
    session_id: envelope.active.session_id,
    run_id: envelope.active.run_id,
  });
  return { negotiation, envelope };
}

/** Stable one-call capability negotiation and surface registration entry point. */
export function registerSurface(
  db: Db,
  id: string,
  input: RegisterSurfaceInput,
): { negotiation: ExperienceNegotiationResult; envelope: ExperienceEnvelope } {
  const { expected_revision: expectedRevision, device_id: deviceId = null, ...request } = input;
  return negotiateAndRegisterSurface(db, id, request, expectedRevision, deviceId);
}
