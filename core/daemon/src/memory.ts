import type { Db } from "./db.ts";
import { newId, nowIso } from "./config.ts";
import { appendEvidence } from "./evidence.ts";

/**
 * Source-attributed memory (blueprint: memory reveals why it was retrieved and
 * where it came from; never silently imported).
 */

const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  scope TEXT NOT NULL,          -- project | session | personal
  content TEXT NOT NULL,
  source_type TEXT NOT NULL,    -- run | user | import
  source_ref TEXT NOT NULL,     -- run id / artifact id / explicit origin
  created_at TEXT NOT NULL
);
`;

export function ensureMemorySchema(db: Db): void {
  db.exec(MEMORY_SCHEMA);
}

export interface MemoryInput {
  project_id: string | null;
  scope: "project" | "session" | "personal";
  content: string;
  source_type: "run" | "user" | "import";
  source_ref: string;
}

export function putMemory(db: Db, item: MemoryInput): string {
  ensureMemorySchema(db);
  const id = newId("mem");
  db.prepare(
    `INSERT INTO memory_items (id, project_id, scope, content, source_type, source_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, item.project_id, item.scope, item.content, item.source_type, item.source_ref, nowIso());
  appendEvidence(db, "memory.stored", "floyd-core", { memory_id: id, scope: item.scope, source_type: item.source_type, source_ref: item.source_ref }, {
    project_id: item.project_id,
  });
  return id;
}

/**
 * Format recalled memory as a source-attributed context block for builder
 * prompts (Objective 3.1). Pure — unit-tested. Always includes the project's
 * test command; includes up to the 5 most recent items.
 */
export function formatMemoryContext(
  items: Array<{ content: unknown; source_type: unknown; source_ref: unknown; created_at: unknown }>,
  testCommand: string,
): string {
  const lines = [
    `## Project memory (source-attributed; recalled by Floyd Core)`,
    `- Test command for this project: \`${testCommand}\``,
  ];
  for (const it of items.slice(0, 5)) {
    lines.push(`- ${String(it.content)} [source ${String(it.source_type)}:${String(it.source_ref)} @ ${String(it.created_at)}]`);
  }
  return lines.join("\n");
}

/** Recall project-scoped memory; each item states why it was retrieved. */
export function recallMemory(db: Db, projectId: string): unknown[] {
  ensureMemorySchema(db);
  const rows = db
    .prepare(`SELECT * FROM memory_items WHERE project_id = ? ORDER BY created_at DESC LIMIT 100`)
    .all(projectId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    ...r,
    why_retrieved: `scope=${String(r.scope)} match for project ${projectId}; source ${String(r.source_type)}:${String(r.source_ref)}`,
  }));
}
