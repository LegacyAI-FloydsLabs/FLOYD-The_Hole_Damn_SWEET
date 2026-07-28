import { createDecipheriv } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConnectorAuthorityService } from "../../apps/frame/server/model-connector-authority.ts";

const TABLES = [
  "connector_profiles",
  "connector_credentials",
  "connector_oauth_attempts",
  "connector_evidence_outbox",
];

/**
 * Copy legacy Core model-connector state into the Vault database, prove every
 * encrypted value authenticates with the original master key, and only then
 * remove the source tables. The caller owns whole-migration backup/rollback.
 */
export function migrateModelConnectorState({
  sourcePath,
  targetPath,
  masterKey,
  removeSource = false,
}) {
  if (!(masterKey instanceof Uint8Array) || masterKey.byteLength !== 32) {
    throw new Error("model-connector migration requires the original 32-byte master key");
  }
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
  const source = new DatabaseSync(sourcePath);
  const target = new DatabaseSync(targetPath);
  try {
    const sourceTables = new Set(source.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'connector_%'",
    ).all().map((row) => String(row.name)));
    if (!sourceTables.has("connector_profiles")) {
      new ConnectorAuthorityService(target, { masterKey });
      chmodSync(targetPath, 0o600);
      return {
        counts: Object.fromEntries(TABLES.map((table) => [table, 0])),
        encryptedValuesVerified: 0,
        decryptionVerified: true,
        sourceRemoved: false,
      };
    }

    new ConnectorAuthorityService(target, { masterKey });
    target.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    try {
      target.exec(`ATTACH DATABASE '${sourcePath.replaceAll("'", "''")}' AS legacy`);
      for (const table of TABLES) {
        if (!sourceTables.has(table)) continue;
        const targetCount = Number(target.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
        if (targetCount !== 0) throw new Error(`Vault ${table} must be empty before legacy import`);
        const sourceColumns = source.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
        const targetColumns = new Set(target.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
        const unsupported = sourceColumns.filter((column) => !targetColumns.has(column));
        if (unsupported.length) {
          throw new Error(`Vault ${table} schema cannot preserve legacy columns: ${unsupported.join(", ")}`);
        }
        const columns = sourceColumns.map(quoteIdentifier).join(", ");
        target.exec(`INSERT INTO main.${quoteIdentifier(table)} (${columns})
          SELECT ${columns} FROM legacy.${quoteIdentifier(table)}`);
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
      if (actual !== expected) throw new Error(`model-connector migration count mismatch for ${table}: ${expected} != ${actual}`);
      counts[table] = actual;
    }
    const encryptedValuesVerified = verifyEncryptedValues(target, masterKey);

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
    return {
      counts,
      encryptedValuesVerified,
      decryptionVerified: true,
      sourceRemoved: removeSource,
    };
  } finally {
    target.close();
    source.close();
  }
}

function verifyEncryptedValues(database, key) {
  let verified = 0;
  for (const row of database.prepare(
    `SELECT id, client_secret_iv, client_secret_tag, client_secret_ciphertext
     FROM connector_profiles WHERE client_secret_ciphertext IS NOT NULL`,
  ).all()) {
    verify(key, `profile:${row.id}:client-secret`,
      row.client_secret_iv, row.client_secret_tag, row.client_secret_ciphertext);
    verified += 1;
  }
  for (const row of database.prepare(
    `SELECT credential_ref, access_iv, access_tag, access_ciphertext,
            refresh_iv, refresh_tag, refresh_ciphertext
     FROM connector_credentials`,
  ).all()) {
    verify(key, `${row.credential_ref}:access`,
      row.access_iv, row.access_tag, row.access_ciphertext);
    verified += 1;
    if (row.refresh_ciphertext !== null) {
      verify(key, `${row.credential_ref}:refresh`,
        row.refresh_iv, row.refresh_tag, row.refresh_ciphertext);
      verified += 1;
    }
  }
  for (const row of database.prepare(
    `SELECT id, verifier_iv, verifier_tag, verifier_ciphertext
     FROM connector_oauth_attempts`,
  ).all()) {
    verify(key, `oauth:${row.id}:verifier`,
      row.verifier_iv, row.verifier_tag, row.verifier_ciphertext);
    verified += 1;
  }
  return verified;
}

function verify(key, aad, iv, tag, ciphertext) {
  if (iv === null || tag === null || ciphertext === null) {
    throw new Error(`model-connector encrypted value is incomplete: ${aad}`);
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(`floyd-connector:v1:${aad}`));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (!plaintext.length) throw new Error("empty secret");
    plaintext.fill(0);
  } catch {
    throw new Error(`model-connector credential verification failed: ${aad}`);
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}
