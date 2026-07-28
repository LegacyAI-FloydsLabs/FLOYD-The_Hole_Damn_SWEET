import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readVaultMigrationBackupEntry,
  VaultMigrationTransaction,
  rollbackVaultMigration,
} from "../lib/vault-migration-transaction.mjs";

test("migration backups restore changed, deleted, and newly-created files", () => {
  const root = mkdtempSync(join(tmpdir(), "vault-migration-transaction-"));
  const existing = join(root, "existing.json");
  const created = join(root, "created.json");
  writeFileSync(existing, "before", { mode: 0o600 });
  const backupKey = randomBytes(32);
  const tx = new VaultMigrationTransaction({ backupRoot: join(root, "backups"), backupKey, id: "proof" });
  tx.backup(existing);
  tx.backup(created);
  tx.recordCreatedKeychainAccount("proof-keychain-account");
  writeFileSync(existing, "after");
  writeFileSync(created, "new");
  const manifest = tx.commit({ receipt: "test" });
  const deletedAccounts = [];
  rollbackVaultMigration(manifest, {
    backupKey,
    deleteKeychainAccount: (account) => deletedAccounts.push(account),
  });
  assert.equal(readFileSync(existing, "utf8"), "before");
  assert.throws(() => readFileSync(created), /ENOENT/);
  assert.equal(JSON.parse(readFileSync(manifest, "utf8")).status, "rolled_back");
  assert.deepEqual(deletedAccounts, ["proof-keychain-account"]);
});

test("sealed migration entry can be inspected in memory for historical credential census", () => {
  const root = mkdtempSync(join(tmpdir(), "vault-migration-inspect-"));
  const source = join(root, "provider-keys.json");
  writeFileSync(source, '{"zai":{"key":"historical-proof-key"}}', { mode: 0o600 });
  const backupKey = randomBytes(32);
  const tx = new VaultMigrationTransaction({
    backupRoot: join(root, "backups"),
    backupKey,
    id: "inspect",
  });
  tx.backup(source);
  const manifest = JSON.parse(readFileSync(tx.commit(), "utf8"));
  const plaintext = readVaultMigrationBackupEntry(manifest.entries[0], backupKey);
  assert.equal(plaintext.toString("utf8"), '{"zai":{"key":"historical-proof-key"}}');
  plaintext.fill(0);
});

test("corrupt backup preflight causes zero file or Keychain mutations", () => {
  const root = mkdtempSync(join(tmpdir(), "vault-migration-corrupt-"));
  const existing = join(root, "existing.json");
  const created = join(root, "created.json");
  writeFileSync(existing, "before", { mode: 0o600 });
  const backupKey = randomBytes(32);
  const tx = new VaultMigrationTransaction({ backupRoot: join(root, "backups"), backupKey, id: "corrupt" });
  tx.backup(existing);
  tx.backup(created);
  tx.recordCreatedKeychainAccount("proof-keychain-account");
  writeFileSync(existing, "after");
  writeFileSync(created, "new");
  const manifestPath = tx.commit({ receipt: "test" });
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifest.entries[0].backup, "corrupt");
  const deletedAccounts = [];

  assert.throws(() => rollbackVaultMigration(manifestPath, {
    backupKey,
    deleteKeychainAccount: (account) => deletedAccounts.push(account),
  }), /digest mismatch/);
  assert.equal(readFileSync(existing, "utf8"), "after");
  assert.equal(readFileSync(created, "utf8"), "new");
  assert.deepEqual(deletedAccounts, []);
  assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).status, "committed");
});
