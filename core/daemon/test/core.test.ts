import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// isolate runtime root BEFORE importing modules that read config
const tmp = mkdtempSync(join(tmpdir(), "floyd-test-"));
process.env.FLOYD_RUNTIME_ROOT = tmp;
mkdirSync(join(tmp, "core"), { recursive: true, mode: 0o700 });

const { openDb } = await import("../src/db.ts");
const { appendEvidence, listEvidence } = await import("../src/evidence.ts");
const { acquireLease, releaseLease } = await import("../src/leases.ts");
const { putArtifact, getArtifact } = await import("../src/artifacts.ts");
const { seed } = await import("../src/seed.ts");
const { createRun } = await import("../src/runs.ts");

const db = openDb(join(tmp, "core", "floyd-test.db"));
seed(db);

test("evidence is append-only at the storage engine", () => {
  const id = appendEvidence(db, "test.event", "test", { a: 1 });
  assert.ok(id.startsWith("evt_"));
  assert.throws(() => db.prepare(`UPDATE evidence_events SET type='tampered' WHERE id=?`).run(id), /append-only/);
  assert.throws(() => db.prepare(`DELETE FROM evidence_events WHERE id=?`).run(id), /append-only/);
});

test("active leases are exclusive per resource path", () => {
  const l1 = acquireLease(db, "worktree", "/tmp/wt-x", "job_a");
  assert.throws(() => acquireLease(db, "worktree", "/tmp/wt-x", "job_b"), /lease conflict/);
  releaseLease(db, l1);
  const l2 = acquireLease(db, "worktree", "/tmp/wt-x", "job_b"); // re-acquirable after release
  assert.ok(l2);
  releaseLease(db, l2);
});

test("artifacts are content-addressed and retrievable", () => {
  const id = putArtifact(db, "hello floyd", "text/plain", "t");
  const again = putArtifact(db, "hello floyd", "text/plain", "t");
  assert.equal(id, again); // same content, same address
  const got = getArtifact(db, id);
  assert.equal(got?.content.toString(), "hello floyd");
});

test("run submission is idempotent on (project, goal)", () => {
  db.prepare(
    `INSERT INTO projects (id, name, root_path, repo_path, test_command, created_at) VALUES ('prj_t', 'tproj', '/tmp/x', '/tmp/x', 'true', 'now')`,
  ).run();
  const first = createRun(db, "prj_t", "do the thing");
  const second = createRun(db, "prj_t", "do the thing");
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(first.run_id, second.run_id);
});

test("evidence listing returns parsed payloads", () => {
  appendEvidence(db, "test.payload", "test", { deep: { v: 42 } });
  const events = listEvidence(db, { limit: 5 }) as Array<{ type: string; payload: unknown }>;
  assert.ok(events.length > 0);
  const mine = events.find((e) => e.type === "test.payload") as { payload: { deep: { v: number } } };
  assert.equal(mine.payload.deep.v, 42);
});

test("memory items are source-attributed and explain retrieval", async () => {
  const { putMemory, recallMemory } = await import("../src/memory.ts");
  putMemory(db, {
    project_id: "prj_t",
    scope: "project",
    content: "scratch project uses node --test",
    source_type: "run",
    source_ref: "run_abc",
  });
  const items = recallMemory(db, "prj_t");
  assert.equal(items.length, 1);
  const it = items[0] as Record<string, unknown>;
  assert.equal(it.content, "scratch project uses node --test");
  assert.equal(it.source_type, "run");
  assert.equal(it.source_ref, "run_abc");
  assert.ok(String(it.why_retrieved).includes("project"));
});

test("memory context block formats recalled items for builder prompts", async () => {
  const { formatMemoryContext } = await import("../src/memory.ts");
  const block = formatMemoryContext(
    [
      { content: "Run X implemented median; merged abc123.", source_type: "run", source_ref: "run_X", created_at: "2026-07-12T00:00:00Z" },
      { content: "Prefers TDD.", source_type: "user", source_ref: "douglas", created_at: "2026-07-12T01:00:00Z" },
    ],
    "node --test",
  );
  assert.ok(block.includes("Project memory"));
  assert.ok(block.includes("median"));
  assert.ok(block.includes("node --test"));
  assert.ok(block.includes("run:run_X")); // source attribution visible in prompt
  assert.equal(formatMemoryContext([], "npm test").includes("npm test"), true); // test command always present
});
