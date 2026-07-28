import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { verifyCoreDatabaseSupersedes } from "../lib/sqlite-superset.mjs";

function makeDatabase(path, rows) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE evidence_events (seq INTEGER PRIMARY KEY, payload_json TEXT NOT NULL);
    CREATE TABLE experience_envelopes (
      id TEXT PRIMARY KEY, schema_version TEXT NOT NULL, revision INTEGER NOT NULL,
      payload_json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by_device_id TEXT
    );
  `);
  for (const event of rows.events) {
    db.prepare("INSERT INTO evidence_events VALUES (?, ?)").run(event.seq, event.payload);
  }
  db.prepare("INSERT INTO experience_envelopes VALUES (?, ?, ?, ?, ?, ?)").run(
    "main", "1", rows.revision, rows.payload, rows.updatedAt, "device",
  );
  db.close();
}

test("active Core database may add rows and monotonically advance envelopes", () => {
  const root = mkdtempSync(join(tmpdir(), "core-db-superset-"));
  const legacy = join(root, "legacy.db");
  const active = join(root, "active.db");
  makeDatabase(legacy, {
    events: [{ seq: 1, payload: "one" }],
    revision: 1, payload: "before", updatedAt: "2026-01-01T00:00:00.000Z",
  });
  makeDatabase(active, {
    events: [{ seq: 1, payload: "one" }, { seq: 2, payload: "two" }],
    revision: 2, payload: "after", updatedAt: "2026-01-02T00:00:00.000Z",
  });
  const receipt = verifyCoreDatabaseSupersedes(active, legacy);
  assert.equal(receipt.ok, true, JSON.stringify(receipt.failures));
  assert.equal(receipt.tables.find(({ table }) => table === "experience_envelopes").advanced, 1);
});

test("missing or rewritten legacy rows fail the superset proof", () => {
  const root = mkdtempSync(join(tmpdir(), "core-db-conflict-"));
  const legacy = join(root, "legacy.db");
  const active = join(root, "active.db");
  makeDatabase(legacy, {
    events: [{ seq: 1, payload: "one" }],
    revision: 2, payload: "newer", updatedAt: "2026-01-02T00:00:00.000Z",
  });
  makeDatabase(active, {
    events: [{ seq: 1, payload: "changed" }],
    revision: 1, payload: "older", updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const receipt = verifyCoreDatabaseSupersedes(active, legacy);
  assert.equal(receipt.ok, false);
  assert.ok(receipt.failures.length >= 2);
});
