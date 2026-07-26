import type { Db } from "./db.ts";
import { newId, nowIso } from "./config.ts";

export interface EvidenceScope {
  project_id?: string | null;
  session_id?: string | null;
  run_id?: string | null;
  job_id?: string | null;
  correlation_id?: string | null;
}

/** Append one evidence event. The table has triggers making it append-only. */
export function appendEvidence(
  db: Db,
  type: string,
  actor: string,
  payload: unknown,
  scope: EvidenceScope = {},
): string {
  const id = newId("evt");
  db.prepare(
    `INSERT INTO evidence_events (id, ts, type, actor, project_id, session_id, run_id, job_id, correlation_id, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    nowIso(),
    type,
    actor,
    scope.project_id ?? null,
    scope.session_id ?? null,
    scope.run_id ?? null,
    scope.job_id ?? null,
    scope.correlation_id ?? null,
    JSON.stringify(payload ?? null),
  );
  return id;
}

export function listEvidence(db: Db, filter: { run_id?: string; limit?: number } = {}): unknown[] {
  const limit = Math.min(filter.limit ?? 200, 1000);
  const rows = filter.run_id
    ? db.prepare(`SELECT * FROM evidence_events WHERE run_id = ? ORDER BY seq ASC LIMIT ?`).all(filter.run_id, limit)
    : db.prepare(`SELECT * FROM evidence_events ORDER BY seq DESC LIMIT ?`).all(limit);
  return rows.map((r) => {
    const row = r as Record<string, unknown>;
    return { ...row, payload: JSON.parse(String(row.payload_json)), payload_json: undefined };
  });
}
