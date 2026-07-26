import { constants, closeSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import {
  FLOYD_DEVICE_SESSION_SCOPES,
  type ExperienceDeviceSessionResources,
  type ExperienceDeviceSessionScope,
} from "@floyd/contracts";
import type { Db } from "./db.ts";

const MASTER_KEY_BYTES = 32;
const SECRET_BYTES = 32;
const MAX_SECRET_CHARS = 256;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_HANDOFF_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_ID_CHARS = 128;
const MIN_HANDOFF_TTL_MS = 5_000;
const MAX_HANDOFF_TTL_MS = 15 * 60_000;
const DEFAULT_HANDOFF_TTL_MS = 2 * 60_000;
const MIN_DEVICE_SESSION_TTL_MS = 60_000;
const MAX_DEVICE_SESSION_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_DEVICE_SESSION_TTL_MS = 15 * 60_000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HANDOFF_TOKEN = /^hnd_([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/;
const DEVICE_SESSION_TOKEN = /^fds_([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/;

export const DEFAULT_REMOTE_DEVICE_SCOPES: ExperienceDeviceSessionScope[] = ["health:read"];
export const DEFAULT_HANDOFF_DEVICE_SCOPES: ExperienceDeviceSessionScope[] = [
  "health:read",
  "state:read",
  "experience:read",
  "experience:write",
  "session:read",
  "session:steer",
  "session:answer",
  "session:permission",
  "run:read",
  "artifact:read",
  "evidence:read",
  "connected_app:read",
  "connected_app:invoke",
  "surface:access",
];
const EMPTY_RESOURCES: ExperienceDeviceSessionResources = {
  envelope_ids: [], project_ids: [], session_ids: [], run_ids: [], artifact_ids: [], connected_app_ids: [],
};

const SECURITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS experience_devices (
  id TEXT PRIMARY KEY,
  secret_salt BLOB NOT NULL,
  secret_verifier BLOB NOT NULL,
  metadata_iv BLOB NOT NULL,
  metadata_tag BLOB NOT NULL,
  metadata_ciphertext BLOB NOT NULL,
  created_at TEXT NOT NULL,
  last_authenticated_at TEXT,
  allowed_scopes_json TEXT NOT NULL DEFAULT '[]',
  transient INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS experience_handoffs (
  id TEXT PRIMARY KEY,
  token_hash BLOB NOT NULL,
  envelope_id TEXT NOT NULL,
  envelope_revision INTEGER NOT NULL CHECK(envelope_revision >= 0),
  created_by_device_id TEXT,
  created_at TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  snapshot_json TEXT,
  paired_device_id TEXT,
  paired_session_id TEXT,
  consumed_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS experience_device_sessions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES experience_devices(id),
  token_hash BLOB NOT NULL,
  scopes_json TEXT NOT NULL,
  resources_json TEXT NOT NULL DEFAULT '{"envelope_ids":[],"project_ids":[],"session_ids":[],"run_ids":[],"artifact_ids":[],"connected_app_ids":[]}',
  snapshot_json TEXT,
  created_at TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS experience_device_sessions_device
  ON experience_device_sessions(device_id, expires_at_ms) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS experience_handoffs_expiry
  ON experience_handoffs(expires_at_ms) WHERE consumed_at IS NULL AND revoked_at IS NULL;
`;

export type ExperienceSecurityEvent = {
  type:
    | "experience.device.enrolled"
    | "experience.device.authenticated"
    | "experience.device.revoked"
    | "experience.device_session.issued"
    | "experience.device_session.revoked"
    | "experience.handoff.issued"
    | "experience.handoff.consumed"
    | "experience.handoff.revoked";
  actor: string;
  payload: Readonly<Record<string, string | number | boolean | null>>;
};

export type ExperienceSecurityOptions = {
  masterKeyPath: string;
  now?: () => number;
  evidence?: (event: ExperienceSecurityEvent) => void;
  sessionInvalidated?: (sessionIds: readonly string[]) => void;
};

export type DeviceEnrollment = {
  deviceId: string;
  secret: string;
  createdAt: string;
  keyId: string;
};

export type AuthenticatedDevice = {
  deviceId: string;
  metadata: Record<string, unknown>;
  authenticatedAt: string;
};

export type DeviceSessionIssue = {
  sessionId: string;
  deviceId: string;
  token: string;
  scopes: ExperienceDeviceSessionScope[];
  resources: ExperienceDeviceSessionResources;
  createdAt: string;
  expiresAt: string;
};

export type AuthenticatedDeviceSession = {
  sessionId: string;
  deviceId: string;
  scopes: ExperienceDeviceSessionScope[];
  resources: ExperienceDeviceSessionResources;
  snapshot: Record<string, unknown> | null;
  expiresAt: string;
};

export type HandoffIssue = {
  handoffId: string;
  token: string;
  envelopeId: string;
  envelopeRevision: number;
  expiresAt: string;
  deepLink: string;
  deepLinkPayload: {
    version: 1;
    handoffId: string;
    token: string;
    envelopeId: string;
    envelopeRevision: number;
  };
};

export type HandoffConsumption = {
  handoffId: string;
  envelopeId: string;
  envelopeRevision: number;
  createdByDeviceId: string | null;
  consumedAt: string;
  snapshot: Record<string, unknown> | null;
};

export type HandoffSessionConsumption = {
  handoff: HandoffConsumption;
  session: DeviceSessionIssue;
};

export type ExperienceSecurityErrorCode =
    | "invalid_input"
    | "invalid_credentials"
    | "device_revoked"
    | "device_session_invalid"
    | "device_session_expired"
    | "device_session_revoked"
    | "scope_denied"
    | "handoff_invalid"
    | "handoff_expired"
    | "handoff_consumed"
    | "handoff_revoked"
    | "handoff_stale"
    | "master_key_invalid";

export class ExperienceSecurityError extends Error {
  readonly code: ExperienceSecurityErrorCode;
  readonly httpStatus: number;

  constructor(
    code: ExperienceSecurityErrorCode,
    message: string,
    httpStatus: number,
  ) {
    super(message);
    this.name = "ExperienceSecurityError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

type DeviceRow = {
  secret_salt: Uint8Array;
  secret_verifier: Uint8Array;
  metadata_iv: Uint8Array;
  metadata_tag: Uint8Array;
  metadata_ciphertext: Uint8Array;
  revoked_at: string | null;
  allowed_scopes_json: string;
};

type HandoffRow = {
  id: string;
  token_hash: Uint8Array;
  envelope_id: string;
  envelope_revision: number;
  created_by_device_id: string | null;
  expires_at_ms: number;
  consumed_at: string | null;
  revoked_at: string | null;
  scopes_json: string;
  snapshot_json: string | null;
  paired_device_id: string | null;
  paired_session_id: string | null;
};

type DeviceSessionRow = {
  id: string;
  device_id: string;
  token_hash: Uint8Array;
  scopes_json: string;
  resources_json: string;
  snapshot_json: string | null;
  created_at: string;
  expires_at_ms: number;
  revoked_at: string | null;
  device_revoked_at: string | null;
};

export function ensureExperienceSecuritySchema(db: Db): void {
  db.exec(SECURITY_SCHEMA);
  const addedDeviceGrants = ensureColumn(db, "experience_devices", "allowed_scopes_json", "TEXT NOT NULL DEFAULT '[]'");
  if (addedDeviceGrants) {
    db.prepare(`UPDATE experience_devices SET allowed_scopes_json = ?`).run(JSON.stringify(FLOYD_DEVICE_SESSION_SCOPES));
  }
  ensureColumn(db, "experience_handoffs", "scopes_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "experience_handoffs", "snapshot_json", "TEXT");
  ensureColumn(db, "experience_handoffs", "paired_device_id", "TEXT");
  ensureColumn(db, "experience_handoffs", "paired_session_id", "TEXT");
  ensureColumn(db, "experience_devices", "transient", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "experience_device_sessions", "resources_json", `TEXT NOT NULL DEFAULT '${JSON.stringify(EMPTY_RESOURCES)}'`);
  ensureColumn(db, "experience_device_sessions", "snapshot_json", "TEXT");
  migrateLegacyDeviceSessionResources(db);
}

/**
 * Owns device enrollment and one-time handoff authority for the portable
 * experience envelope. Provider keys and device secrets must never be passed
 * to the evidence callback; emitted payloads contain public identifiers only.
 */
export class ExperienceSecurityService {
  readonly db: Db;
  readonly keyId: string;
  readonly #key: Buffer;
  readonly #now: () => number;
  readonly #evidence?: (event: ExperienceSecurityEvent) => void;
  readonly #sessionInvalidated?: (sessionIds: readonly string[]) => void;

  constructor(db: Db, options: ExperienceSecurityOptions) {
    this.db = db;
    ensureExperienceSecuritySchema(db);
    this.#key = loadOrCreateMasterKey(options.masterKeyPath);
    this.keyId = createHash("sha256").update(this.#key).digest("hex").slice(0, 16);
    this.#now = options.now ?? Date.now;
    this.#evidence = options.evidence;
    this.#sessionInvalidated = options.sessionInvalidated;
  }

  async enrollDevice(
    metadata: Record<string, unknown>,
    requestedDeviceId?: string,
    allowedScopesInput: readonly ExperienceDeviceSessionScope[] = FLOYD_DEVICE_SESSION_SCOPES,
  ): Promise<DeviceEnrollment> {
    const deviceId = requestedDeviceId === undefined ? `dev_${randomBytes(12).toString("base64url")}` : validId(requestedDeviceId, "deviceId");
    const metadataJson = validMetadata(metadata);
    const secret = randomBytes(SECRET_BYTES).toString("base64url");
    const salt = randomBytes(16);
    const verifier = await deriveSecret(secret, salt);
    const encrypted = encryptMetadata(this.#key, deviceId, metadataJson);
    const createdAt = new Date(this.#now()).toISOString();
    const allowedScopes = validDeviceSessionScopes(allowedScopesInput);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO experience_devices
           (id, secret_salt, secret_verifier, metadata_iv, metadata_tag, metadata_ciphertext, created_at, allowed_scopes_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(deviceId, salt, verifier, encrypted.iv, encrypted.tag, encrypted.ciphertext, createdAt, JSON.stringify(allowedScopes));
      this.#emit("experience.device.enrolled", deviceId, { device_id: deviceId, key_id: this.keyId });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (String(error).includes("UNIQUE constraint failed")) invalid("deviceId is already enrolled");
      throw error;
    }
    return { deviceId, secret, createdAt, keyId: this.keyId };
  }

  async authenticateDevice(deviceIdInput: string, secret: string): Promise<AuthenticatedDevice> {
    const deviceId = validId(deviceIdInput, "deviceId");
    validSecret(secret);
    const row = this.db
      .prepare(
        `SELECT secret_salt, secret_verifier, metadata_iv, metadata_tag, metadata_ciphertext, revoked_at
         , allowed_scopes_json FROM experience_devices WHERE id = ?`,
      )
      .get(deviceId) as unknown as DeviceRow | undefined;

    // A dummy derivation makes unknown-device and wrong-secret paths comparable.
    const salt = row ? Buffer.from(row.secret_salt) : Buffer.alloc(16);
    const candidate = await deriveSecret(secret, salt);
    const stored = row ? Buffer.from(row.secret_verifier) : Buffer.alloc(candidate.length);
    const accepted = candidate.length === stored.length && timingSafeEqual(candidate, stored);
    if (!row || !accepted) throw new ExperienceSecurityError("invalid_credentials", "invalid device credentials", 401);
    if (row.revoked_at) throw new ExperienceSecurityError("device_revoked", "device has been revoked", 403);

    const metadata = decryptMetadata(this.#key, deviceId, row);
    const authenticatedAt = new Date(this.#now()).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare(`SELECT revoked_at FROM experience_devices WHERE id = ?`).get(deviceId) as { revoked_at: string | null } | undefined;
      if (!current || current.revoked_at) throw new ExperienceSecurityError("device_revoked", "device has been revoked", 403);
      this.db.prepare(`UPDATE experience_devices SET last_authenticated_at = ? WHERE id = ?`).run(authenticatedAt, deviceId);
      this.#emit("experience.device.authenticated", deviceId, { device_id: deviceId });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { deviceId, metadata, authenticatedAt };
  }

  issueDeviceSession(
    deviceIdInput: string,
    scopesInput: readonly ExperienceDeviceSessionScope[] = DEFAULT_REMOTE_DEVICE_SCOPES,
    ttlMs = DEFAULT_DEVICE_SESSION_TTL_MS,
    actor = "core",
    resourcesInput: ExperienceDeviceSessionResources = EMPTY_RESOURCES,
  ): DeviceSessionIssue {
    const deviceId = validId(deviceIdInput, "deviceId");
    const requestedScopes = validDeviceSessionScopes(scopesInput);
    const resources = validDeviceSessionResources(resourcesInput);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_DEVICE_SESSION_TTL_MS || ttlMs > MAX_DEVICE_SESSION_TTL_MS) {
      invalid(`device session ttlMs must be an integer between ${MIN_DEVICE_SESSION_TTL_MS} and ${MAX_DEVICE_SESSION_TTL_MS}`);
    }
    const device = this.db.prepare(`SELECT allowed_scopes_json FROM experience_devices WHERE id = ? AND revoked_at IS NULL`).get(deviceId) as { allowed_scopes_json: string } | undefined;
    if (!device) {
      throw new ExperienceSecurityError("device_revoked", "device is unknown or revoked", 403);
    }
    const scopes = intersectScopes(requestedScopes, parseStoredDeviceSessionScopes(device.allowed_scopes_json));
    if (scopes.length === 0) throw new ExperienceSecurityError("scope_denied", "device has no approved requested scopes", 403);

    const sessionId = generateRouteId();
    const tokenSecret = randomBytes(SECRET_BYTES).toString("base64url");
    const token = `fds_${sessionId}.${tokenSecret}`;
    const now = this.#now();
    const createdAt = new Date(now).toISOString();
    const expiresAtMs = now + ttlMs;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare(`SELECT revoked_at FROM experience_devices WHERE id = ?`).get(deviceId) as { revoked_at: string | null } | undefined;
      if (!current || current.revoked_at) throw new ExperienceSecurityError("device_revoked", "device is unknown or revoked", 403);
      this.db.prepare(`DELETE FROM experience_device_sessions WHERE expires_at_ms < ?`).run(now - 24 * 60 * 60_000);
      this.db.prepare(
        `INSERT INTO experience_device_sessions
         (id, device_id, token_hash, scopes_json, resources_json, created_at, expires_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(sessionId, deviceId, hashTokenSecret(tokenSecret), JSON.stringify(scopes), JSON.stringify(resources), createdAt, expiresAtMs);
      this.#emit("experience.device_session.issued", actor, {
        session_id: sessionId,
        device_id: deviceId,
        scope_count: scopes.length,
        expires_at_ms: expiresAtMs,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { sessionId, deviceId, token, scopes, resources, createdAt, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  authenticateDeviceSession(
    tokenInput: string,
    requiredScope?: ExperienceDeviceSessionScope,
    requiredResource?: { kind: keyof ExperienceDeviceSessionResources; id: string },
  ): AuthenticatedDeviceSession {
    const { id, secret } = parseDeviceSessionToken(tokenInput);
    const row = this.db.prepare(
        `SELECT s.*, d.revoked_at AS device_revoked_at
         FROM experience_device_sessions s
         JOIN experience_devices d ON d.id = s.device_id
         WHERE s.id = ?`,
      ).get(id) as unknown as DeviceSessionRow | undefined;
    verifyDeviceSessionSecret(row, secret);
    if (row!.device_revoked_at) throw new ExperienceSecurityError("device_revoked", "device has been revoked", 403);
    if (row!.revoked_at) throw new ExperienceSecurityError("device_session_revoked", "device session has been revoked", 401);
    if (this.#now() >= row!.expires_at_ms) throw new ExperienceSecurityError("device_session_expired", "device session has expired", 401);
    const scopes = parseStoredDeviceSessionScopes(row!.scopes_json);
    const resources = parseStoredDeviceSessionResources(row!.resources_json);
    const snapshot = parseHandoffSnapshot(row!.snapshot_json);
    if (requiredScope && !scopes.includes(requiredScope)) {
      throw new ExperienceSecurityError("scope_denied", `device session lacks ${requiredScope}`, 403);
    }
    if (requiredResource && !resources[requiredResource.kind].includes(requiredResource.id)) {
      throw new ExperienceSecurityError("scope_denied", `device session is not authorized for ${requiredResource.kind}`, 403);
    }
    return { sessionId: id, deviceId: row!.device_id, scopes, resources, snapshot, expiresAt: new Date(row!.expires_at_ms).toISOString() };
  }

  getDeviceSessionSnapshot(sessionIdInput: string): Record<string, unknown> | null {
    const sessionId = validId(sessionIdInput, "sessionId");
    const row = this.db.prepare(`SELECT snapshot_json FROM experience_device_sessions WHERE id = ?`).get(sessionId) as { snapshot_json: string | null } | undefined;
    return row ? parseHandoffSnapshot(row.snapshot_json) : null;
  }

  replaceDeviceSessionSnapshot(
    sessionIdInput: string,
    expectedEnvelopeRevision: number,
    snapshot: Record<string, unknown>,
  ): boolean {
    const sessionId = validId(sessionIdInput, "sessionId");
    const serialized = validHandoffSnapshot(snapshot);
    this.db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const row = this.db.prepare(
        `SELECT s.snapshot_json, s.expires_at_ms, s.revoked_at, d.revoked_at AS device_revoked_at
         FROM experience_device_sessions s JOIN experience_devices d ON d.id = s.device_id
         WHERE s.id = ?`,
      ).get(sessionId) as { snapshot_json: string | null; expires_at_ms: number; revoked_at: string | null; device_revoked_at: string | null } | undefined;
      if (!row || row.revoked_at || row.device_revoked_at || this.#now() >= row.expires_at_ms) {
        throw new ExperienceSecurityError("device_session_expired", "device session is no longer active", 401);
      }
      const current = parseHandoffSnapshot(row.snapshot_json);
      const envelope = current?.envelope as { revision?: unknown } | undefined;
      if (!envelope || envelope.revision !== expectedEnvelopeRevision) {
        this.db.exec("COMMIT");
        committed = true;
        return false;
      }
      this.db.prepare(`UPDATE experience_device_sessions SET snapshot_json = ? WHERE id = ?`).run(serialized, sessionId);
      this.db.exec("COMMIT");
      committed = true;
      return true;
    } catch (error) {
      if (!committed) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  cleanupExpiredTransientDevices(actor = "core"): number {
    const now = this.#now();
    const revokedAt = new Date(now).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const rows = this.db.prepare(
        `SELECT d.id FROM experience_devices d
         WHERE d.transient = 1 AND d.revoked_at IS NULL AND NOT EXISTS (
           SELECT 1 FROM experience_device_sessions s
           WHERE s.device_id = d.id AND s.revoked_at IS NULL AND s.expires_at_ms > ?
         )`,
      ).all(now) as Array<{ id: string }>;
      for (const row of rows) {
        this.db.prepare(`UPDATE experience_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(revokedAt, row.id);
        this.db.prepare(`UPDATE experience_device_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE device_id = ?`).run(revokedAt, row.id);
        this.#emit("experience.device.revoked", actor, { device_id: row.id });
      }
      this.db.exec("COMMIT");
      committed = true;
      return rows.length;
    } catch (error) {
      if (!committed) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  revokeDeviceSession(sessionIdInput: string, actor = "core"): boolean {
    const sessionId = validId(sessionIdInput, "sessionId");
    const revokedAt = new Date(this.#now()).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT device_id FROM experience_device_sessions WHERE id = ?`).get(sessionId) as { device_id: string } | undefined;
      const result = this.db.prepare(
        `UPDATE experience_device_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
      ).run(revokedAt, sessionId);
      const revoked = Number(result.changes) === 1;
      if (revoked) this.#emit("experience.device_session.revoked", actor, {
        session_id: sessionId,
        device_id: row?.device_id ?? null,
      });
      this.db.exec("COMMIT");
      if (revoked) this.#sessionInvalidated?.([sessionId]);
      return revoked;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  isTransientDevice(deviceIdInput: string): boolean {
    const deviceId = validId(deviceIdInput, "deviceId");
    const row = this.db.prepare(`SELECT transient FROM experience_devices WHERE id = ?`).get(deviceId) as { transient: number } | undefined;
    return row?.transient === 1;
  }

  revokeDevice(deviceIdInput: string, actor = "core"): boolean {
    const deviceId = validId(deviceIdInput, "deviceId");
    const revokedAt = new Date(this.#now()).toISOString();
    let invalidatedSessionIds: string[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(`UPDATE experience_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
        .run(revokedAt, deviceId);
      const revoked = Number(result.changes) === 1;
      if (revoked) {
        const sessionRows = this.db.prepare(
          `SELECT id FROM experience_device_sessions WHERE device_id = ? AND revoked_at IS NULL`,
        ).all(deviceId) as Array<{ id: string }>;
        this.db.prepare(
          `UPDATE experience_device_sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL`,
        ).run(revokedAt, deviceId);
        this.db.prepare(
          `UPDATE experience_handoffs SET revoked_at = ? WHERE created_by_device_id = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
        ).run(revokedAt, deviceId);
        this.#emit("experience.device.revoked", actor, { device_id: deviceId });
        invalidatedSessionIds = sessionRows.map((row) => row.id);
      }
      this.db.exec("COMMIT");
      if (revoked) this.#sessionInvalidated?.(invalidatedSessionIds);
      return revoked;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  issueHandoff(input: {
    envelopeId: string;
    envelopeRevision: number;
    createdByDeviceId?: string;
    ttlMs?: number;
    scopes?: readonly ExperienceDeviceSessionScope[];
    snapshot?: Record<string, unknown>;
  }): HandoffIssue {
    const envelopeId = validId(input.envelopeId, "envelopeId");
    const revision = validRevision(input.envelopeRevision);
    const createdBy = input.createdByDeviceId === undefined ? null : validId(input.createdByDeviceId, "createdByDeviceId");
    const ttlMs = input.ttlMs ?? DEFAULT_HANDOFF_TTL_MS;
    const scopes = validDeviceSessionScopes(input.scopes ?? DEFAULT_HANDOFF_DEVICE_SCOPES);
    const snapshotJson = input.snapshot === undefined ? null : validHandoffSnapshot(input.snapshot);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_HANDOFF_TTL_MS || ttlMs > MAX_HANDOFF_TTL_MS) {
      invalid(`ttlMs must be an integer between ${MIN_HANDOFF_TTL_MS} and ${MAX_HANDOFF_TTL_MS}`);
    }
    if (createdBy && !this.db.prepare(`SELECT id FROM experience_devices WHERE id = ? AND revoked_at IS NULL`).get(createdBy)) {
      throw new ExperienceSecurityError("invalid_credentials", "creating device is unknown or revoked", 401);
    }

    // Raw base64url may begin with '-' or '_', which is valid entropy but not
    // a valid route ID. Regenerate that rare leading character without
    // changing the published 16-character handoff token format.
    const handoffId = generateRouteId();
    const tokenSecret = randomBytes(SECRET_BYTES).toString("base64url");
    const token = `hnd_${handoffId}.${tokenSecret}`;
    const tokenHash = hashTokenSecret(tokenSecret);
    const now = this.#now();
    const createdAt = new Date(now).toISOString();
    const expiresAtMs = now + ttlMs;
    const deepLinkPayload = { version: 1 as const, handoffId, token, envelopeId, envelopeRevision: revision };
    const query = new URLSearchParams({
      v: "1",
      id: handoffId,
      token,
      envelope: envelopeId,
      revision: String(revision),
    });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO experience_handoffs
           (id, token_hash, envelope_id, envelope_revision, created_by_device_id, created_at, expires_at_ms, scopes_json, snapshot_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(handoffId, tokenHash, envelopeId, revision, createdBy, createdAt, expiresAtMs, JSON.stringify(scopes), snapshotJson);
      this.#emit("experience.handoff.issued", createdBy ?? "core", {
        handoff_id: handoffId,
        envelope_id: envelopeId,
        envelope_revision: revision,
        expires_at_ms: expiresAtMs,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      handoffId,
      token,
      envelopeId,
      envelopeRevision: revision,
      expiresAt: new Date(expiresAtMs).toISOString(),
      deepLink: `floyd://handoff?${query.toString()}`,
      deepLinkPayload,
    };
  }

  consumeHandoff(
    tokenInput: string,
    actorDeviceId?: string,
    validateRevision?: (envelopeId: string, envelopeRevision: number) => void,
  ): HandoffConsumption {
    const { id, secret } = parseHandoffToken(tokenInput);
    const actor = actorDeviceId === undefined ? "unclaimed-device" : validId(actorDeviceId, "actorDeviceId");
    this.db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const row = this.db.prepare(`SELECT * FROM experience_handoffs WHERE id = ?`).get(id) as unknown as HandoffRow | undefined;
      verifyHandoffSecret(row, secret);
      if (row!.revoked_at) throw new ExperienceSecurityError("handoff_revoked", "handoff has been revoked", 410);
      if (row!.consumed_at) throw new ExperienceSecurityError("handoff_consumed", "handoff has already been consumed", 409);
      if (this.#now() >= row!.expires_at_ms) throw new ExperienceSecurityError("handoff_expired", "handoff has expired", 410);
      // The caller validates against its authoritative envelope inside this
      // same IMMEDIATE transaction. A stale token is not consumed, so a failed
      // attach never burns an otherwise inspectable/revocable credential.
      validateRevision?.(row!.envelope_id, row!.envelope_revision);

      const consumedAt = new Date(this.#now()).toISOString();
      const update = this.db
        .prepare(`UPDATE experience_handoffs SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL`)
        .run(consumedAt, id);
      if (Number(update.changes) !== 1) throw new ExperienceSecurityError("handoff_consumed", "handoff has already been consumed", 409);
      this.#emit("experience.handoff.consumed", actor, {
        handoff_id: id,
        envelope_id: row!.envelope_id,
        envelope_revision: row!.envelope_revision,
      });
      this.db.exec("COMMIT");
      committed = true;
      return {
        handoffId: id,
        envelopeId: row!.envelope_id,
        envelopeRevision: row!.envelope_revision,
        createdByDeviceId: row!.created_by_device_id,
        consumedAt,
        snapshot: parseHandoffSnapshot(row!.snapshot_json),
      };
    } catch (error) {
      if (!committed) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Atomically consumes a one-time handoff and mints its resource-bound access
   * session. If revision validation, session insertion, or durable evidence
   * fails, neither authority change is committed.
   */
  consumeHandoffForDevice(
    tokenInput: string,
    actorDeviceIdInput: string,
    resolveResources: (envelopeId: string, envelopeRevision: number, snapshot: Record<string, unknown> | null) => ExperienceDeviceSessionResources,
    ttlMs = DEFAULT_DEVICE_SESSION_TTL_MS,
  ): HandoffSessionConsumption {
    const { id, secret } = parseHandoffToken(tokenInput);
    const actorDeviceId = validId(actorDeviceIdInput, "actorDeviceId");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_DEVICE_SESSION_TTL_MS || ttlMs > DEFAULT_DEVICE_SESSION_TTL_MS) {
      invalid(`handoff device session ttlMs must be an integer between ${MIN_DEVICE_SESSION_TTL_MS} and ${DEFAULT_DEVICE_SESSION_TTL_MS}`);
    }

    this.db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const row = this.db.prepare(`SELECT * FROM experience_handoffs WHERE id = ?`).get(id) as unknown as HandoffRow | undefined;
      verifyHandoffSecret(row, secret);
      if (row!.revoked_at) throw new ExperienceSecurityError("handoff_revoked", "handoff has been revoked", 410);
      if (row!.consumed_at) throw new ExperienceSecurityError("handoff_consumed", "handoff has already been consumed", 409);
      if (this.#now() >= row!.expires_at_ms) throw new ExperienceSecurityError("handoff_expired", "handoff has expired", 410);

      const device = this.db.prepare(
        `SELECT allowed_scopes_json, revoked_at FROM experience_devices WHERE id = ?`,
      ).get(actorDeviceId) as { allowed_scopes_json: string; revoked_at: string | null } | undefined;
      if (!device || device.revoked_at) throw new ExperienceSecurityError("device_revoked", "device is unknown or revoked", 403);
      const scopes = intersectScopes(
        parseStoredDeviceSessionScopes(row!.scopes_json),
        parseStoredDeviceSessionScopes(device.allowed_scopes_json),
      );
      if (scopes.length === 0) throw new ExperienceSecurityError("scope_denied", "handoff and device have no shared approved scopes", 403);
      const snapshot = parseHandoffSnapshot(row!.snapshot_json);
      const resources = validDeviceSessionResources(resolveResources(row!.envelope_id, row!.envelope_revision, snapshot));

      const sessionId = generateRouteId();
      const tokenSecret = randomBytes(SECRET_BYTES).toString("base64url");
      const token = `fds_${sessionId}.${tokenSecret}`;
      const now = this.#now();
      const createdAt = new Date(now).toISOString();
      const expiresAtMs = now + ttlMs;
      this.db.prepare(
        `INSERT INTO experience_device_sessions
         (id, device_id, token_hash, scopes_json, resources_json, snapshot_json, created_at, expires_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(sessionId, actorDeviceId, hashTokenSecret(tokenSecret), JSON.stringify(scopes), JSON.stringify(resources), row!.snapshot_json, createdAt, expiresAtMs);

      const consumedAt = new Date(this.#now()).toISOString();
      const update = this.db.prepare(
        `UPDATE experience_handoffs SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
      ).run(consumedAt, id);
      if (Number(update.changes) !== 1) throw new ExperienceSecurityError("handoff_consumed", "handoff has already been consumed", 409);
      this.#emit("experience.device_session.issued", actorDeviceId, {
        session_id: sessionId,
        device_id: actorDeviceId,
        scope_count: scopes.length,
        expires_at_ms: expiresAtMs,
      });
      this.#emit("experience.handoff.consumed", actorDeviceId, {
        handoff_id: id,
        envelope_id: row!.envelope_id,
        envelope_revision: row!.envelope_revision,
      });
      this.db.exec("COMMIT");
      committed = true;
      return {
        handoff: {
          handoffId: id,
          envelopeId: row!.envelope_id,
          envelopeRevision: row!.envelope_revision,
          createdByDeviceId: row!.created_by_device_id,
          consumedAt,
          snapshot,
        },
        session: {
          sessionId,
          deviceId: actorDeviceId,
          token,
          scopes,
          resources,
          createdAt,
          expiresAt: new Date(expiresAtMs).toISOString(),
        },
      };
    } catch (error) {
      if (!committed) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * First-device pairing for a scanned QR. Possession of the short-lived,
   * consume-once handoff token enrolls a transient browser device and issues
   * its resource-bound session in one SQLite transaction. The generated
   * permanent device secret is intentionally never returned to JavaScript.
   */
  async pairHandoff(
    tokenInput: string,
    metadata: Record<string, unknown>,
    resolveResources: (envelopeId: string, envelopeRevision: number, snapshot: Record<string, unknown> | null) => ExperienceDeviceSessionResources,
    ttlMs = DEFAULT_DEVICE_SESSION_TTL_MS,
  ): Promise<HandoffSessionConsumption> {
    const { id, secret: handoffSecret } = parseHandoffToken(tokenInput);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_DEVICE_SESSION_TTL_MS || ttlMs > DEFAULT_DEVICE_SESSION_TTL_MS) {
      invalid(`handoff device session ttlMs must be an integer between ${MIN_DEVICE_SESSION_TTL_MS} and ${DEFAULT_DEVICE_SESSION_TTL_MS}`);
    }
    const preflight = this.db.prepare(`SELECT * FROM experience_handoffs WHERE id = ?`).get(id) as unknown as HandoffRow | undefined;
    verifyHandoffSecret(preflight, handoffSecret);
    if (preflight!.revoked_at) throw new ExperienceSecurityError("handoff_revoked", "handoff has been revoked", 410);
    if (this.#now() >= preflight!.expires_at_ms) throw new ExperienceSecurityError("handoff_expired", "handoff has expired", 410);
    if (preflight!.consumed_at) return this.#recoverPairedHandoff(preflight!, handoffSecret);

    const deviceId = `dev_pair_${randomBytes(10).toString("base64url")}`;
    const metadataJson = validMetadata({ ...metadata, transient_pairing: true });
    const discardedSecret = randomBytes(SECRET_BYTES).toString("base64url");
    const salt = randomBytes(16);
    const verifier = await deriveSecret(discardedSecret, salt);
    const encrypted = encryptMetadata(this.#key, deviceId, metadataJson);
    const now = this.#now();
    const createdAt = new Date(now).toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const row = this.db.prepare(`SELECT * FROM experience_handoffs WHERE id = ?`).get(id) as unknown as HandoffRow | undefined;
      verifyHandoffSecret(row, handoffSecret);
      if (row!.revoked_at) throw new ExperienceSecurityError("handoff_revoked", "handoff has been revoked", 410);
      if (this.#now() >= row!.expires_at_ms) throw new ExperienceSecurityError("handoff_expired", "handoff has expired", 410);
      if (row!.consumed_at) {
        this.db.exec("COMMIT");
        committed = true;
        return this.#recoverPairedHandoff(row!, handoffSecret);
      }
      const scopes = parseStoredDeviceSessionScopes(row!.scopes_json);
      if (scopes.length === 0) throw new ExperienceSecurityError("scope_denied", "handoff has no approved scopes", 403);
      const snapshot = parseHandoffSnapshot(row!.snapshot_json);
      const resources = validDeviceSessionResources(resolveResources(row!.envelope_id, row!.envelope_revision, snapshot));
      const sessionId = generateRouteId();
      const sessionSecret = derivePairedSessionSecret(this.#key, id, sessionId, handoffSecret);
      const sessionToken = `fds_${sessionId}.${sessionSecret}`;
      const expiresAtMs = now + ttlMs;

      this.db.prepare(
        `UPDATE experience_devices SET revoked_at = ?
         WHERE transient = 1 AND revoked_at IS NULL AND NOT EXISTS (
           SELECT 1 FROM experience_device_sessions s
           WHERE s.device_id = experience_devices.id AND s.revoked_at IS NULL AND s.expires_at_ms > ?
         )`,
      ).run(createdAt, now);

      this.db.prepare(
        `INSERT INTO experience_devices
         (id, secret_salt, secret_verifier, metadata_iv, metadata_tag, metadata_ciphertext, created_at, allowed_scopes_json, transient)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(deviceId, salt, verifier, encrypted.iv, encrypted.tag, encrypted.ciphertext, createdAt, JSON.stringify(scopes));
      this.db.prepare(
        `INSERT INTO experience_device_sessions
         (id, device_id, token_hash, scopes_json, resources_json, snapshot_json, created_at, expires_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(sessionId, deviceId, hashTokenSecret(sessionSecret), JSON.stringify(scopes), JSON.stringify(resources), row!.snapshot_json, createdAt, expiresAtMs);
      const consumedAt = new Date(this.#now()).toISOString();
      const update = this.db.prepare(
        `UPDATE experience_handoffs SET consumed_at = ?, paired_device_id = ?, paired_session_id = ?
         WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
      ).run(consumedAt, deviceId, sessionId, id);
      if (Number(update.changes) !== 1) throw new ExperienceSecurityError("handoff_consumed", "handoff has already been consumed", 409);
      this.#emit("experience.device.enrolled", deviceId, { device_id: deviceId, key_id: this.keyId });
      this.#emit("experience.device_session.issued", deviceId, {
        session_id: sessionId, device_id: deviceId, scope_count: scopes.length, expires_at_ms: expiresAtMs,
      });
      this.#emit("experience.handoff.consumed", deviceId, {
        handoff_id: id, envelope_id: row!.envelope_id, envelope_revision: row!.envelope_revision,
      });
      this.db.exec("COMMIT");
      committed = true;
      return {
        handoff: {
          handoffId: id,
          envelopeId: row!.envelope_id,
          envelopeRevision: row!.envelope_revision,
          createdByDeviceId: row!.created_by_device_id,
          consumedAt,
          snapshot,
        },
        session: {
          sessionId,
          deviceId,
          token: sessionToken,
          scopes,
          resources,
          createdAt,
          expiresAt: new Date(expiresAtMs).toISOString(),
        },
      };
    } catch (error) {
      if (!committed) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Recover the exact pairing result after a lost HTTP response. The one-time
   * handoff never creates a second device or session: the same bearer derives
   * the same session secret until the handoff itself expires.
   */
  #recoverPairedHandoff(row: HandoffRow, handoffSecret: string): HandoffSessionConsumption {
    if (!row.paired_device_id || !row.paired_session_id || !row.consumed_at) {
      throw new ExperienceSecurityError("handoff_consumed", "handoff has already been consumed", 409);
    }
    const session = this.db.prepare(
      `SELECT s.*, d.revoked_at AS device_revoked_at
       FROM experience_device_sessions s
       JOIN experience_devices d ON d.id = s.device_id
       WHERE s.id = ? AND s.device_id = ?`,
    ).get(row.paired_session_id, row.paired_device_id) as unknown as DeviceSessionRow | undefined;
    if (!session || session.device_revoked_at || session.revoked_at || this.#now() >= session.expires_at_ms) {
      throw new ExperienceSecurityError("handoff_consumed", "paired handoff session is no longer recoverable", 409);
    }
    const sessionSecret = derivePairedSessionSecret(this.#key, row.id, session.id, handoffSecret);
    const candidate = hashTokenSecret(sessionSecret);
    const stored = Buffer.from(session.token_hash);
    if (candidate.length !== stored.length || !timingSafeEqual(candidate, stored)) {
      throw new ExperienceSecurityError("handoff_invalid", "paired handoff session integrity check failed", 500);
    }
    const snapshot = parseHandoffSnapshot(session.snapshot_json);
    return {
      handoff: {
        handoffId: row.id,
        envelopeId: row.envelope_id,
        envelopeRevision: row.envelope_revision,
        createdByDeviceId: row.created_by_device_id,
        consumedAt: row.consumed_at,
        snapshot,
      },
      session: {
        sessionId: session.id,
        deviceId: session.device_id,
        token: `fds_${session.id}.${sessionSecret}`,
        scopes: parseStoredDeviceSessionScopes(session.scopes_json),
        resources: parseStoredDeviceSessionResources(session.resources_json),
        createdAt: session.created_at,
        expiresAt: new Date(session.expires_at_ms).toISOString(),
      },
    };
  }

  /** Core-authority operation backing DELETE /api/handoffs/:id. */
  revokeHandoff(handoffIdInput: string, actor = "core"): boolean {
    const id = validId(handoffIdInput, "handoffId");
    this.db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const row = this.db.prepare(`SELECT * FROM experience_handoffs WHERE id = ?`).get(id) as unknown as HandoffRow | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        committed = true;
        return false;
      }
      const revokedAt = new Date(this.#now()).toISOString();
      const result = this.db
        // Revoking a consumed pairing closes its idempotent recovery window;
        // the already-issued session remains valid until logout or expiry.
        .prepare(`UPDATE experience_handoffs SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
        .run(revokedAt, id);
      const revoked = Number(result.changes) === 1;
      if (revoked) this.#emit("experience.handoff.revoked", actor, { handoff_id: id, envelope_id: row.envelope_id });
      this.db.exec("COMMIT");
      committed = true;
      return revoked;
    } catch (error) {
      if (!committed) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #emit(type: ExperienceSecurityEvent["type"], actor: string, payload: ExperienceSecurityEvent["payload"]): void {
    this.#evidence?.({ type, actor, payload });
  }
}

function loadOrCreateMasterKey(path: string): Buffer {
  if (!isAbsolute(path) || path.length > 4096 || path.includes("\0")) {
    throw new ExperienceSecurityError("master_key_invalid", "master key path must be a valid absolute path", 500);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeSync(fd, randomBytes(MASTER_KEY_BYTES));
    fchmodSync(fd, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  let readFd: number | undefined;
  try {
    readFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(readFd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
      throw new ExperienceSecurityError("master_key_invalid", "master key must be a regular, singly-linked 0600 file", 500);
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new ExperienceSecurityError("master_key_invalid", "master key must be owned by the Core user", 500);
    }
    const key = readFileSync(readFd);
    if (key.length !== MASTER_KEY_BYTES) {
      throw new ExperienceSecurityError("master_key_invalid", `master key must contain exactly ${MASTER_KEY_BYTES} bytes`, 500);
    }
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ExperienceSecurityError("master_key_invalid", "master key must not be a symbolic link", 500);
    }
    throw error;
  } finally {
    if (readFd !== undefined) closeSync(readFd);
  }
}

async function deriveSecret(secret: string, salt: Uint8Array): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(secret, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function validSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length < 32 || secret.length > MAX_SECRET_CHARS) {
    throw new ExperienceSecurityError("invalid_credentials", "invalid device credentials", 401);
  }
}

function validId(value: string, field: string): string {
  if (typeof value !== "string" || value.length > MAX_ID_CHARS || !IDENTIFIER.test(value)) invalid(`${field} is invalid`);
  return value;
}

function validRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) invalid("envelopeRevision must be a non-negative safe integer");
  return value;
}

function validMetadata(metadata: Record<string, unknown>): string {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata) || Object.getPrototypeOf(metadata) !== Object.prototype) {
    invalid("metadata must be a plain object");
  }
  let json: string;
  try {
    json = JSON.stringify(metadata);
  } catch {
    invalid("metadata must be JSON serializable");
  }
  if (json === undefined || Buffer.byteLength(json) > MAX_METADATA_BYTES) invalid(`metadata exceeds ${MAX_METADATA_BYTES} bytes`);
  return json;
}

function encryptMetadata(key: Uint8Array, deviceId: string, plaintext: string): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`floyd-device-metadata:v1:${deviceId}`));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

function decryptMetadata(key: Uint8Array, deviceId: string, row: DeviceRow): Record<string, unknown> {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, row.metadata_iv);
    decipher.setAAD(Buffer.from(`floyd-device-metadata:v1:${deviceId}`));
    decipher.setAuthTag(Buffer.from(row.metadata_tag));
    const plaintext = Buffer.concat([decipher.update(row.metadata_ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new ExperienceSecurityError("master_key_invalid", "device metadata authentication failed", 500);
  }
}

function parseHandoffToken(token: string): { id: string; secret: string } {
  if (typeof token !== "string" || token.length > MAX_SECRET_CHARS) {
    throw new ExperienceSecurityError("handoff_invalid", "invalid handoff token", 401);
  }
  const match = HANDOFF_TOKEN.exec(token);
  if (!match) throw new ExperienceSecurityError("handoff_invalid", "invalid handoff token", 401);
  return { id: match[1]!, secret: match[2]! };
}

function parseDeviceSessionToken(token: string): { id: string; secret: string } {
  if (typeof token !== "string" || token.length > MAX_SECRET_CHARS) {
    throw new ExperienceSecurityError("device_session_invalid", "invalid device session", 401);
  }
  const match = DEVICE_SESSION_TOKEN.exec(token);
  if (!match) throw new ExperienceSecurityError("device_session_invalid", "invalid device session", 401);
  return { id: match[1]!, secret: match[2]! };
}

function hashTokenSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function derivePairedSessionSecret(key: Buffer, handoffId: string, sessionId: string, handoffSecret: string): string {
  return createHmac("sha256", key)
    .update("floyd-paired-session-v1\0")
    .update(handoffId)
    .update("\0")
    .update(sessionId)
    .update("\0")
    .update(handoffSecret)
    .digest("base64url");
}

function verifyHandoffSecret(row: HandoffRow | undefined, secret: string): asserts row is HandoffRow {
  const candidate = hashTokenSecret(secret);
  const stored = row ? Buffer.from(row.token_hash) : Buffer.alloc(candidate.length);
  if (!row || candidate.length !== stored.length || !timingSafeEqual(candidate, stored)) {
    throw new ExperienceSecurityError("handoff_invalid", "invalid handoff token", 401);
  }
}

function verifyDeviceSessionSecret(row: DeviceSessionRow | undefined, secret: string): asserts row is DeviceSessionRow {
  const candidate = hashTokenSecret(secret);
  const stored = row ? Buffer.from(row.token_hash) : Buffer.alloc(candidate.length);
  if (!row || candidate.length !== stored.length || !timingSafeEqual(candidate, stored)) {
    throw new ExperienceSecurityError("device_session_invalid", "invalid device session", 401);
  }
}

function validDeviceSessionScopes(scopes: readonly ExperienceDeviceSessionScope[]): ExperienceDeviceSessionScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > FLOYD_DEVICE_SESSION_SCOPES.length) {
    invalid("device session scopes are invalid");
  }
  const unique = [...new Set(scopes)];
  for (const scope of unique) {
    if (!FLOYD_DEVICE_SESSION_SCOPES.includes(scope)) invalid(`unsupported device session scope: ${String(scope)}`);
  }
  return unique.sort();
}

function parseStoredDeviceSessionScopes(value: string): ExperienceDeviceSessionScope[] {
  try {
    return validDeviceSessionScopes(JSON.parse(value) as ExperienceDeviceSessionScope[]);
  } catch (error) {
    if (error instanceof ExperienceSecurityError) throw error;
    throw new ExperienceSecurityError("device_session_invalid", "stored device session scopes are invalid", 401);
  }
}

function intersectScopes(
  requested: readonly ExperienceDeviceSessionScope[],
  allowed: readonly ExperienceDeviceSessionScope[],
): ExperienceDeviceSessionScope[] {
  const allowedSet = new Set(allowed);
  return requested.filter((scope) => allowedSet.has(scope));
}

function validDeviceSessionResources(input: ExperienceDeviceSessionResources): ExperienceDeviceSessionResources {
  if (input === null || typeof input !== "object" || Array.isArray(input)) invalid("device session resources are invalid");
  const output = {} as ExperienceDeviceSessionResources;
  for (const key of ["envelope_ids", "project_ids", "session_ids", "run_ids", "artifact_ids", "connected_app_ids"] as const) {
    const values = input[key];
    if (!Array.isArray(values) || values.length > 128) invalid(`device session ${key} are invalid`);
    output[key] = [...new Set(values.map((value) => validId(value, key)))].sort();
  }
  return output;
}

function parseStoredDeviceSessionResources(value: string): ExperienceDeviceSessionResources {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) invalid("stored device session resources are invalid");
    return validDeviceSessionResources({ ...EMPTY_RESOURCES, ...parsed as Partial<ExperienceDeviceSessionResources> });
  } catch (error) {
    if (error instanceof ExperienceSecurityError) throw error;
    throw new ExperienceSecurityError("device_session_invalid", "stored device session resources are invalid", 401);
  }
}

function migrateLegacyDeviceSessionResources(db: Db): void {
  const rows = db.prepare(`SELECT id, resources_json FROM experience_device_sessions`).all() as Array<{ id: string; resources_json: string }>;
  const update = db.prepare(`UPDATE experience_device_sessions SET resources_json = ? WHERE id = ?`);
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.resources_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && !Object.hasOwn(parsed, "connected_app_ids")) {
        update.run(JSON.stringify(validDeviceSessionResources({ ...EMPTY_RESOURCES, ...parsed as Partial<ExperienceDeviceSessionResources> })), row.id);
      }
    } catch {
      // Preserve corrupt rows so authentication continues to fail closed.
    }
  }
}

function validHandoffSnapshot(snapshot: Record<string, unknown>): string {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) invalid("handoff snapshot is invalid");
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized) > MAX_HANDOFF_SNAPSHOT_BYTES) invalid("handoff snapshot exceeds 1 MiB");
  return serialized;
}

function parseHandoffSnapshot(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ExperienceSecurityError("handoff_invalid", "stored handoff snapshot is invalid", 500);
  }
}

function ensureColumn(db: Db, table: string, column: string, declaration: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  return true;
}

function generateRouteId(): string {
  let id: string;
  do id = randomBytes(12).toString("base64url");
  while (!IDENTIFIER.test(id));
  return id;
}

function invalid(message: string): never {
  throw new ExperienceSecurityError("invalid_input", message, 400);
}
