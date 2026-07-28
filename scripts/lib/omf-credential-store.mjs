import { chmodSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const SECRET_FIELD = /(?:api.?key|access.?token|refresh.?token|secret|password|credential)/i;

export function inspectOmfCredentialStore(databasePath) {
  if (!existsSync(databasePath)) return { exists: false, rows: [] };
  const database = new DatabaseSync(databasePath);
  try {
    const hasTable = Number(database.prepare(
      "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='auth_credentials'",
    ).get().count) > 0;
    if (!hasTable) return { exists: true, rows: [] };
    const rows = database.prepare(
      "SELECT id, provider, credential_type, data FROM auth_credentials ORDER BY id",
    ).all().map((row) => ({
      id: Number(row.id),
      provider: String(row.provider),
      credentialType: String(row.credential_type),
      secrets: extractSecrets(String(row.data)),
    }));
    return { exists: true, rows };
  } finally {
    database.close();
  }
}

export function lockOmfCredentialStore(databasePath) {
  if (!existsSync(databasePath)) throw new Error(`OMF credential store is missing: ${databasePath}`);
  const database = new DatabaseSync(databasePath);
  try {
    const hasTable = Number(database.prepare(
      "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='auth_credentials'",
    ).get().count) > 0;
    if (!hasTable) throw new Error("OMF credential store has no auth_credentials table");
    const removed = Number(database.prepare("SELECT count(*) AS count FROM auth_credentials").get().count);
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(`
        DELETE FROM auth_credentials;
        DROP TRIGGER IF EXISTS floyd_vault_block_auth_insert;
        DROP TRIGGER IF EXISTS floyd_vault_block_auth_update;
        CREATE TRIGGER floyd_vault_block_auth_insert
        BEFORE INSERT ON auth_credentials
        BEGIN
          SELECT RAISE(ABORT, 'Floyd Vault is the sole credential authority');
        END;
        CREATE TRIGGER floyd_vault_block_auth_update
        BEFORE UPDATE ON auth_credentials
        BEGIN
          SELECT RAISE(ABORT, 'Floyd Vault is the sole credential authority');
        END;
      `);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return { removed, locked: true };
  } finally {
    database.close();
    chmodSync(databasePath, 0o600);
  }
}

function extractSecrets(encoded) {
  let parsed;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return encoded ? [encoded] : [];
  }
  const secrets = [];
  const visit = (value, key = "") => {
    if (typeof value === "string") {
      if (SECRET_FIELD.test(key) && value) secrets.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, key);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
  };
  visit(parsed);
  return [...new Set(secrets)];
}
