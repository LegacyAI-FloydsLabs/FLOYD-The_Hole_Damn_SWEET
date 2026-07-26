import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.ts";
import { PATHS, nowIso } from "./config.ts";

/** Content-addressed artifact store under FLOYD_RUNTIME/artifacts/<aa>/<sha256>. */
export function putArtifact(db: Db, content: string | Buffer, mime: string, label: string): string {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const sha = createHash("sha256").update(buf).digest("hex");
  const dir = join(PATHS.artifacts, sha.slice(0, 2));
  const file = join(dir, sha);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, buf, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  db.prepare(
    `INSERT OR IGNORE INTO artifacts (id, mime, bytes, label, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(sha, mime, buf.length, label, nowIso());
  return sha;
}

export function getArtifact(db: Db, id: string): { meta: Record<string, unknown>; content: Buffer } | null {
  if (!/^[0-9a-f]{64}$/.test(id)) return null;
  const meta = db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!meta) return null;
  const file = join(PATHS.artifacts, id.slice(0, 2), id);
  if (!existsSync(file)) return null;
  return { meta, content: readFileSync(file) };
}

export function linkRunArtifact(db: Db, runId: string, jobId: string | null, artifactId: string, role: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO run_artifacts (run_id, job_id, artifact_id, role) VALUES (?, ?, ?, ?)`,
  ).run(runId, jobId, artifactId, role);
}
