import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { PATHS } from "./config.ts";

export type Db = DatabaseSync;

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  root_path TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  test_command TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  agent_spec_id TEXT NOT NULL,
  engine_session_id TEXT,
  worktree_lease_id TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  resource_path TEXT NOT NULL,
  holder_job_id TEXT NOT NULL,
  status TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  released_at TEXT
);
-- exclusivity: at most one ACTIVE lease per resource path
CREATE UNIQUE INDEX IF NOT EXISTS leases_active_exclusive
  ON leases(resource_path) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,          -- sha256 content address
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_artifacts (
  run_id TEXT NOT NULL REFERENCES runs(id),
  job_id TEXT,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  role TEXT NOT NULL,           -- diff | test_output | transcript | review | route_receipt
  PRIMARY KEY (run_id, artifact_id, role)
);

CREATE TABLE IF NOT EXISTS agent_specs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  provider_profile_id TEXT NOT NULL,
  model TEXT NOT NULL,
  permission_policy_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_profiles (
  id TEXT PRIMARY KEY,
  vendor TEXT NOT NULL,
  billing_class TEXT NOT NULL,
  plan_name TEXT NOT NULL,
  region TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  endpoint_class TEXT NOT NULL,
  model_allowlist_json TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,
  fallback_policy TEXT NOT NULL DEFAULT 'fail_closed'
);

CREATE TABLE IF NOT EXISTS evidence_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  project_id TEXT,
  session_id TEXT,
  run_id TEXT,
  job_id TEXT,
  correlation_id TEXT,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS experience_envelopes (
  id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_device_id TEXT
);

-- append-only enforcement: any UPDATE or DELETE on evidence fails at the engine
CREATE TRIGGER IF NOT EXISTS evidence_no_update
  BEFORE UPDATE ON evidence_events
  BEGIN SELECT RAISE(ABORT, 'evidence_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS evidence_no_delete
  BEFORE DELETE ON evidence_events
  BEGIN SELECT RAISE(ABORT, 'evidence_events is append-only'); END;
`;

export function openDb(path: string = PATHS.db): Db {
  const fresh = !existsSync(path);
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  if (fresh) {
    chmodSync(path, 0o600);
  }
  return db;
}
