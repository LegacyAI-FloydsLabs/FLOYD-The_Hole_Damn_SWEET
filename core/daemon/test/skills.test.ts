import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "floyd-skills-"));
process.env.FLOYD_RUNTIME_ROOT = tmp;
mkdirSync(join(tmp, "core"), { recursive: true, mode: 0o700 });

const { openDb } = await import("../src/db.ts");
const { registerSkill, loadSkill, listSkills, resolveSkillVersion } = await import("../src/skills.ts");

const db = openDb(join(tmp, "core", "skills-test.db"));

test("registers a skill with a semantic version and content digest", () => {
  const v = registerSkill(db, {
    name: "code-review",
    version: "1.0.0",
    body: "# Code Review Skill\nReview diffs for correctness.",
    permissions: ["read"],
  });
  assert.equal(v.name, "code-review");
  assert.equal(v.version, "1.0.0");
  assert.match(v.digest, /^[0-9a-f]{64}$/);
});

test("same content yields same digest; re-register is idempotent", () => {
  const a = registerSkill(db, { name: "code-review", version: "1.0.0", body: "# Code Review Skill\nReview diffs for correctness.", permissions: ["read"] });
  assert.equal(a.digest, listSkills(db).find((s) => s.name === "code-review" && s.version === "1.0.0")!.digest);
});

test("loads a skill on demand by name and version", () => {
  const loaded = loadSkill(db, "code-review", "1.0.0");
  assert.ok(loaded);
  assert.equal(loaded.name, "code-review");
  assert.match(loaded.body, /Review diffs/);
  assert.deepEqual(loaded.permissions, ["read"]);
});

test("resolves latest version when none specified (semver-aware)", () => {
  registerSkill(db, { name: "code-review", version: "1.2.0", body: "v120", permissions: ["read"] });
  registerSkill(db, { name: "code-review", version: "1.10.0", body: "v1100", permissions: ["read"] });
  assert.equal(resolveSkillVersion(db, "code-review"), "1.10.0"); // 1.10.0 > 1.2.0, not string order
  const latest = loadSkill(db, "code-review");
  assert.equal(latest!.version, "1.10.0");
});

test("returns null for unknown skill or version", () => {
  assert.equal(loadSkill(db, "nonexistent"), null);
  assert.equal(loadSkill(db, "code-review", "9.9.9"), null);
});
