import { createHash } from "node:crypto";
import type { Db } from "./db.ts";
import { nowIso } from "./config.ts";
import { appendEvidence } from "./evidence.ts";

/**
 * Versioned skills registry (blueprint "Skills"; Objective 3.2). Skills are
 * immutable (name, version, digest) rows; the builder loads them on demand.
 */

const SKILLS_SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  digest TEXT NOT NULL,
  body TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (name, version)
);
`;

export function ensureSkillsSchema(db: Db): void {
  db.exec(SKILLS_SCHEMA);
}

export interface SkillInput {
  name: string;
  version: string;
  body: string;
  permissions: string[];
}

export interface SkillVersion {
  name: string;
  version: string;
  digest: string;
  body: string;
  permissions: string[];
  created_at?: string;
}

function digestOf(name: string, version: string, body: string, permissions: string[]): string {
  return createHash("sha256").update(`${name}@${version}\n${JSON.stringify(permissions)}\n${body}`).digest("hex");
}

export function registerSkill(db: Db, input: SkillInput): SkillVersion {
  ensureSkillsSchema(db);
  const digest = digestOf(input.name, input.version, input.body, input.permissions);
  db.prepare(
    `INSERT INTO skills (name, version, digest, body, permissions_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name, version) DO UPDATE SET digest=excluded.digest, body=excluded.body, permissions_json=excluded.permissions_json`,
  ).run(input.name, input.version, digest, input.body, JSON.stringify(input.permissions), nowIso());
  appendEvidence(db, "skill.registered", "floyd-core", { name: input.name, version: input.version, digest });
  return { name: input.name, version: input.version, digest, body: input.body, permissions: input.permissions };
}

function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function resolveSkillVersion(db: Db, name: string): string | null {
  ensureSkillsSchema(db);
  const rows = db.prepare(`SELECT version FROM skills WHERE name = ?`).all(name) as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  return rows.map((r) => String(r.version)).sort(cmpSemver).at(-1) ?? null;
}

export function loadSkill(db: Db, name: string, version?: string): SkillVersion | null {
  ensureSkillsSchema(db);
  const v = version ?? resolveSkillVersion(db, name);
  if (!v) return null;
  const row = db.prepare(`SELECT * FROM skills WHERE name = ? AND version = ?`).get(name, v) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    name: String(row.name),
    version: String(row.version),
    digest: String(row.digest),
    body: String(row.body),
    permissions: JSON.parse(String(row.permissions_json)) as string[],
    created_at: String(row.created_at),
  };
}

export function listSkills(db: Db): SkillVersion[] {
  ensureSkillsSchema(db);
  const rows = db.prepare(`SELECT name, version, digest, permissions_json, created_at FROM skills ORDER BY name, version`).all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    name: String(r.name),
    version: String(r.version),
    digest: String(r.digest),
    body: "",
    permissions: JSON.parse(String(r.permissions_json)) as string[],
    created_at: String(r.created_at),
  }));
}
