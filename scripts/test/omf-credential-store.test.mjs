import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  inspectOmfCredentialStore,
  lockOmfCredentialStore,
} from "../lib/omf-credential-store.mjs";

test("OMF credential lock removes only credentials and rejects later writes", () => {
  const path = join(mkdtempSync(join(tmpdir(), "floyd-omf-store-")), "agent.db");
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE auth_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('theme', 'floyd');
  `);
  database.prepare(
    "INSERT INTO auth_credentials(provider, credential_type, data) VALUES (?, ?, ?)",
  ).run("github", "api", JSON.stringify({ access_token: "test-secret-value" }));
  database.close();

  assert.deepEqual(inspectOmfCredentialStore(path).rows[0].secrets, ["test-secret-value"]);
  assert.deepEqual(lockOmfCredentialStore(path), { removed: 1, locked: true });

  const verified = new DatabaseSync(path);
  assert.equal(verified.prepare("SELECT count(*) AS count FROM auth_credentials").get().count, 0);
  assert.equal(verified.prepare("SELECT value FROM settings WHERE name='theme'").get().value, "floyd");
  assert.throws(() => verified.prepare(
    "INSERT INTO auth_credentials(provider, credential_type, data) VALUES (?, ?, ?)",
  ).run("github", "api", "{}"), /Floyd Vault is the sole credential authority/);
  verified.close();
});
