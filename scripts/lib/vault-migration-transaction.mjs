import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export class VaultMigrationTransaction {
  constructor({
    backupRoot,
    backupKey,
    exec = execFileSync,
    id = migrationId(),
    existingManifestPath = null,
  }) {
    if (!(backupKey instanceof Uint8Array) || backupKey.byteLength !== 32) {
      throw new Error("migration transaction requires a 32-byte Keychain backup key");
    }
    this.backupKey = Buffer.from(backupKey);
    this.exec = exec;
    if (existingManifestPath) {
      this.manifestPath = existingManifestPath;
      this.directory = dirname(existingManifestPath);
      this.manifest = JSON.parse(readFileSync(existingManifestPath, "utf8"));
      return;
    }
    this.directory = join(backupRoot, id);
    this.manifestPath = join(this.directory, "manifest.json");
    this.manifest = {
      version: 1,
      id,
      status: "pending",
      createdAt: new Date().toISOString(),
      entries: [],
      createdKeychainAccounts: [],
    };
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.#saveManifest();
  }

  backup(path, { sqlite = false } = {}) {
    if (this.manifest.status !== "pending") throw new Error("migration transaction is not pending");
    if (this.manifest.entries.some((entry) => entry.path === path)) return;
    const exists = existsSync(path);
    const index = String(this.manifest.entries.length).padStart(4, "0");
    const backup = join(this.directory, `${index}-${basename(path)}${sqlite ? ".sqlite" : ""}.sealed`);
    const entry = {
      path,
      backup: exists ? backup : null,
      existed: exists,
      mode: exists ? statSync(path).mode & 0o777 : null,
      sha256: null,
      iv: null,
      tag: null,
      sqlite,
    };
    if (exists) {
      let plaintext;
      if (sqlite) {
        const temporarySqlite = `${backup}.plain-${process.pid}`;
        // Do not use immutable=1 here: it ignores uncheckpointed WAL state.
        // SQLite's online backup reads the coherent database plus WAL.
        this.exec("/usr/bin/sqlite3", [path, `.backup '${temporarySqlite.replaceAll("'", "''")}'`]);
        plaintext = readFileSync(temporarySqlite);
        rmSync(temporarySqlite);
      } else {
        plaintext = readFileSync(path);
      }
      const sealed = seal(this.backupKey, path, plaintext);
      plaintext.fill(0);
      writeFileSync(backup, sealed.ciphertext, { mode: 0o600 });
      chmodSync(backup, 0o600);
      entry.sha256 = fileDigest(backup);
      entry.iv = sealed.iv.toString("base64");
      entry.tag = sealed.tag.toString("base64");
    }
    this.manifest.entries.push(entry);
    this.#saveManifest();
  }

  commit(extra = {}) {
    if (this.manifest.status !== "pending") throw new Error("migration transaction is not pending");
    this.manifest.status = "committed";
    this.manifest.committedAt = new Date().toISOString();
    Object.assign(this.manifest, extra);
    this.#saveManifest();
    return this.manifestPath;
  }

  recordCreatedKeychainAccount(account) {
    if (!this.manifest.createdKeychainAccounts.includes(account)) {
      this.manifest.createdKeychainAccounts.push(account);
      this.#saveManifest();
    }
  }

  rollback({ deleteKeychainAccount } = {}) {
    if (!["pending", "committed"].includes(this.manifest.status)) {
      throw new Error(`cannot roll back migration in state ${this.manifest.status}`);
    }
    const accounts = this.manifest.createdKeychainAccounts || [];
    if (accounts.length && !deleteKeychainAccount) {
      throw new Error(`rollback requires Keychain deletion support for ${accounts[0]}`);
    }

    // Preflight every sealed backup before mutating either files or Keychain.
    // A single corrupt late entry therefore leaves the current state intact.
    const prepared = [];
    try {
      for (const entry of [...this.manifest.entries].reverse()) {
        if (!entry.existed) {
          prepared.push({ entry, plaintext: null });
          continue;
        }
        if (!entry.backup || fileDigest(entry.backup) !== entry.sha256) {
          throw new Error(`migration backup digest mismatch: ${entry.path}`);
        }
        prepared.push({
          entry,
          plaintext: unseal(
            this.backupKey,
            entry.path,
            readFileSync(entry.backup),
            Buffer.from(entry.iv, "base64"),
            Buffer.from(entry.tag, "base64"),
          ),
        });
      }
    } catch (error) {
      for (const item of prepared) item.plaintext?.fill(0);
      throw error;
    }

    try {
      for (const { entry, plaintext } of prepared) {
        if (!entry.existed) {
          if (existsSync(entry.path)) rmSync(entry.path);
          continue;
        }
        const temporary = `${entry.path}.vault-rollback-${process.pid}`;
        writeFileSync(temporary, plaintext, { mode: entry.mode });
        chmodSync(temporary, entry.mode);
        renameSync(temporary, entry.path);
      }
      for (const account of accounts) deleteKeychainAccount(account);
    } finally {
      for (const item of prepared) item.plaintext?.fill(0);
    }
    this.manifest.status = "rolled_back";
    this.manifest.rolledBackAt = new Date().toISOString();
    this.#saveManifest();
    return this.manifestPath;
  }

  #saveManifest() {
    const temporary = `${this.manifestPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.manifest, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.manifestPath);
  }
}

export function rollbackVaultMigration(manifestPath, {
  backupKey,
  exec = execFileSync,
  deleteKeychainAccount,
} = {}) {
  if (!(backupKey instanceof Uint8Array) || backupKey.byteLength !== 32) {
    throw new Error("rollback requires the migration's 32-byte Keychain backup key");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  void manifest;
  const transaction = new VaultMigrationTransaction({
    backupKey,
    exec,
    existingManifestPath: manifestPath,
  });
  return transaction.rollback({ deleteKeychainAccount });
}

export function readVaultMigrationBackupEntry(entry, backupKey) {
  if (!(backupKey instanceof Uint8Array) || backupKey.byteLength !== 32) {
    throw new Error("reading a migration backup requires its 32-byte Keychain backup key");
  }
  if (!entry?.existed || !entry.backup) return null;
  if (fileDigest(entry.backup) !== entry.sha256) {
    throw new Error(`migration backup digest mismatch: ${entry.path}`);
  }
  return unseal(
    Buffer.from(backupKey),
    entry.path,
    readFileSync(entry.backup),
    Buffer.from(entry.iv, "base64"),
    Buffer.from(entry.tag, "base64"),
  );
}

function fileDigest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function migrationId() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
}

function seal(key, path, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`floyd-vault-migration:v1:${path}`));
  return {
    iv,
    tag: undefined,
    ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]),
    get tag() { return cipher.getAuthTag(); },
  };
}

function unseal(key, path, ciphertext, iv, tag) {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(`floyd-vault-migration:v1:${path}`));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
