import type { Db } from "./db.ts";
import { newId, nowIso } from "./config.ts";
import { appendEvidence } from "./evidence.ts";

/**
 * Exclusive resource leases. The partial unique index `leases_active_exclusive`
 * makes a second ACTIVE lease on the same path a constraint violation at the
 * storage engine — builder and reviewer physically cannot race one worktree.
 */
export function acquireLease(
  db: Db,
  resourceType: "worktree" | "pty" | "sandbox",
  resourcePath: string,
  holderJobId: string,
  scope: { run_id?: string; project_id?: string } = {},
): string {
  const id = newId("lse");
  try {
    db.prepare(
      `INSERT INTO leases (id, resource_type, resource_path, holder_job_id, status, acquired_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    ).run(id, resourceType, resourcePath, holderJobId, nowIso());
  } catch (err) {
    throw new Error(`lease conflict: ${resourcePath} already actively leased (${String(err)})`);
  }
  appendEvidence(db, "lease.acquired", "floyd-core", { lease_id: id, resourceType, resourcePath, holderJobId }, {
    run_id: scope.run_id ?? null,
    project_id: scope.project_id ?? null,
    job_id: holderJobId,
  });
  return id;
}

export function releaseLease(db: Db, leaseId: string): void {
  db.prepare(`UPDATE leases SET status = 'released', released_at = ? WHERE id = ? AND status = 'active'`).run(
    nowIso(),
    leaseId,
  );
  appendEvidence(db, "lease.released", "floyd-core", { lease_id: leaseId });
}
