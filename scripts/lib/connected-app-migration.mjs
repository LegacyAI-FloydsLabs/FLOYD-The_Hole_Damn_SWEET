import { createDecipheriv } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConnectedAppAuthorityService } from "../../apps/frame/server/connected-app-authority.ts";

const TABLES = [
  "connected_app_profiles",
  "connected_app_credentials",
  "connected_app_oauth_attempts",
  "connected_app_evidence_outbox",
];

/**
 * Copy legacy Core connected-app state into the Vault database, verify row
 * equality and authenticated decryption, then (and only then) remove source
 * rows. The caller owns whole-migration backups/rollback.
 */
export function migrateConnectedAppState({
  sourcePath,
  targetPath,
  masterKey,
  removeSource = false,
}) {
  if (!(masterKey instanceof Uint8Array) || masterKey.byteLength !== 32) {
    throw new Error("connected-app migration requires the original 32-byte master key");
  }
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
  const source = new DatabaseSync(sourcePath);
  const target = new DatabaseSync(targetPath);
  try {
    const sourceTables = new Set(source.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'connected_app_%'",
    ).all().map((row) => String(row.name)));
    if (!sourceTables.has("connected_app_profiles")) {
      new ConnectedAppAuthorityService(target, { masterKey });
      chmodSync(targetPath, 0o600);
      return { counts: Object.fromEntries(TABLES.map((table) => [table, 0])), decryptionVerified: true, sourceRemoved: false };
    }

    new ConnectedAppAuthorityService(target, { masterKey });
    target.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    try {
      target.exec(`ATTACH DATABASE '${sourcePath.replaceAll("'", "''")}' AS legacy`);
      for (const table of TABLES) {
        if (!sourceTables.has(table)) continue;
        const targetCount = Number(target.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
        if (targetCount !== 0) throw new Error(`Vault ${table} must be empty before legacy import`);
        target.exec(`INSERT INTO main.${table} SELECT * FROM legacy.${table}`);
      }
      target.exec("COMMIT");
    } catch (error) {
      target.exec("ROLLBACK");
      throw error;
    } finally {
      try { target.exec("DETACH DATABASE legacy"); } catch {}
    }

    const counts = {};
    for (const table of TABLES) {
      const expected = sourceTables.has(table)
        ? Number(source.prepare(`SELECT count(*) AS count FROM ${table}`).get().count)
        : 0;
      const actual = Number(target.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
      if (actual !== expected) throw new Error(`connected-app migration count mismatch for ${table}: ${expected} != ${actual}`);
      counts[table] = actual;
    }
    const decryptionVerified = verifyOneCredential(target, masterKey);

    if (removeSource) {
      source.exec("BEGIN IMMEDIATE");
      try {
        for (const table of [...TABLES].reverse()) {
          if (sourceTables.has(table)) source.exec(`DROP TABLE ${table}`);
        }
        source.exec("COMMIT");
      } catch (error) {
        source.exec("ROLLBACK");
        throw error;
      }
    }
    chmodSync(targetPath, 0o600);
    return { counts, decryptionVerified, sourceRemoved: removeSource };
  } finally {
    target.close();
    source.close();
  }
}

function verifyOneCredential(database, key) {
  const row = database.prepare(
    `SELECT p.id, p.authorization_server, p.resource_url,
            c.access_iv, c.access_tag, c.access_ciphertext
     FROM connected_app_credentials c
     JOIN connected_app_profiles p ON p.id = c.connector_id
     ORDER BY c.credential_ref LIMIT 1`,
  ).get();
  if (!row) return true;
  try {
    const aad = `credential:${row.id}:${row.authorization_server}:${row.resource_url}:access`;
    const decipher = createDecipheriv("aes-256-gcm", key, row.access_iv);
    decipher.setAAD(Buffer.from(`floyd-connected-app:v1:${aad}`));
    decipher.setAuthTag(row.access_tag);
    const plaintext = Buffer.concat([decipher.update(row.access_ciphertext), decipher.final()]);
    if (!plaintext.length) throw new Error("decrypted access credential is empty");
    plaintext.fill(0);
    return true;
  } catch {
    throw new Error("connected-app credential verification failed with the imported master key");
  }
}
