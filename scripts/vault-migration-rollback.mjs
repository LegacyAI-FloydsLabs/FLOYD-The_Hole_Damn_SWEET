#!/usr/bin/env node
import { resolve } from "node:path";
import { rollbackVaultMigration } from "./lib/vault-migration-transaction.mjs";
import { MacOSKeychainVault } from "../apps/frame/server/keychain-vault.mjs";

const manifest = process.argv[2];
if (!manifest) {
  console.error("usage: vault-migration-rollback.mjs /absolute/path/to/manifest.json");
  process.exit(2);
}
const keychain = new MacOSKeychainVault();
const migration = JSON.parse(await import("node:fs").then(({ readFileSync }) => readFileSync(resolve(manifest), "utf8")));
const backupKeys = keychain.readJson("migration-backup-keys");
const encodedKey = backupKeys[migration.id];
if (!encodedKey) throw new Error(`Keychain has no backup key for migration ${migration.id}`);
const receipt = rollbackVaultMigration(resolve(manifest), {
  backupKey: Buffer.from(encodedKey, "base64"),
  deleteKeychainAccount: (account) => keychain.delete(account),
});
console.log(JSON.stringify({ ok: true, rolledBack: receipt }));
