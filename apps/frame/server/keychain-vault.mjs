import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export const FLOYD_KEYCHAIN_SERVICE = "space.legacyai.floyd.vault";
export const FLOYD_KEYCHAIN_ACCOUNTS = Object.freeze({
  providers: "provider-credentials",
  management: "management-auth",
  subscription: "chatgpt-subscription",
  connectedAppMaster: "connected-app-master",
  modelConnectorMaster: "model-connector-master",
  remoteMcpTargets: "remote-mcp-targets",
  migrationBackups: "migration-backup-keys",
});

/**
 * Store Vault secrets in the macOS login Keychain instead of ordinary files.
 *
 * This gives the local Node architecture encrypted-at-rest storage governed by
 * the login Keychain. It does not pretend that an arbitrary malicious process
 * already executing as the same logged-in user is a separate OS principal.
 */
export class MacOSKeychainVault {
  constructor({
    service = FLOYD_KEYCHAIN_SERVICE,
    exec = execFileSync,
    platform = process.platform,
  } = {}) {
    if (platform !== "darwin") {
      throw new Error("FLOYD Vault requires the macOS Keychain on this platform");
    }
    this.service = service;
    this.exec = exec;
  }

  get(account) {
    validateAccount(account);
    try {
      return String(this.exec("/usr/bin/security", [
        "find-generic-password",
        "-a", account,
        "-s", this.service,
        "-w",
      ], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })).replace(/\r?\n$/, "");
    } catch (error) {
      if (error?.status === 44 || error?.status === 45) return null;
      throw new Error(`macOS Keychain read failed for ${account}: ${error?.message || error}`);
    }
  }

  set(account, secret) {
    validateAccount(account);
    if (typeof secret !== "string" || !secret) throw new Error("Keychain secret must be a non-empty string");
    if (/[\r\n]/.test(secret)) throw new Error("Keychain secret must be a single line");
    // Always delete-then-create. Updating an existing item (-U) rewrites its
    // ACL, and SecKeychainItemSetAccess prompts the user for the login
    // password every time. Creating a fresh item sets the ACL silently.
    this.delete(account);
    if (secret.length <= INTERACTIVE_LINE_SAFE_LIMIT) {
      // Interactive mode: the full command line arrives on stdin, so the
      // secret never appears in the child argv. Prompt mode (-w with no
      // value) is unusable: readpassphrase silently truncates at 128 bytes
      // while still exiting 0.
      this.exec("/usr/bin/security", ["-i"], {
        encoding: "utf8",
        input: `${[
          "add-generic-password",
          "-a", account,
          "-s", this.service,
          "-D", "application password",
          // Trust the security CLI itself. An empty ACL (-T "") makes macOS
          // prompt the user for the login password on EVERY read, and
          // same-user processes can invoke the CLI anyway (see the
          // threat-model note above), so an empty ACL adds prompts, not
          // protection.
          "-T", "/usr/bin/security",
          "-w", secret,
        ].map(interactiveQuote).join(" ")}\n`,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      // security -i truncates lines around 4KB. For larger values (OAuth
      // token bundles) pass the secret via argv: on macOS argv is readable
      // only by the same user and root, which the threat model above
      // already treats as equivalent to the process itself.
      this.exec("/usr/bin/security", [
        "add-generic-password",
        "-a", account,
        "-s", this.service,
        "-D", "application password",
        "-T", "/usr/bin/security",
        "-w", secret,
      ], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
    // Both security input modes have silent-truncation failure shapes that
    // exit 0, so every write is verified by read-back.
    const written = this.get(account);
    if (written !== secret) {
      throw new Error(`macOS Keychain write verification failed for ${account}`);
    }
  }

  delete(account) {
    validateAccount(account);
    try {
      this.exec("/usr/bin/security", [
        "delete-generic-password",
        "-a", account,
        "-s", this.service,
      ], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return true;
    } catch (error) {
      if (error?.status === 44 || error?.status === 45) return false;
      throw new Error(`macOS Keychain delete failed for ${account}: ${error?.message || error}`);
    }
  }

  readJson(account, fallback = {}) {
    const encoded = this.get(account);
    if (encoded === null) return structuredClone(fallback);
    let parsed;
    try {
      parsed = JSON.parse(encoded);
    } catch {
      throw new Error(`macOS Keychain item ${account} is not valid JSON`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`macOS Keychain item ${account} must contain a JSON object`);
    }
    return parsed;
  }

  writeJson(account, value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Vault JSON value must be an object");
    }
    this.set(account, JSON.stringify(value));
  }

  ensureManagementToken() {
    const existing = this.get(FLOYD_KEYCHAIN_ACCOUNTS.management);
    if (existing) {
      if (!/^fm_[0-9a-f]{64}$/.test(existing)) {
        throw new Error("macOS Keychain contains an invalid FLOYD management capability");
      }
      return existing;
    }
    const token = `fm_${randomBytes(32).toString("hex")}`;
    this.set(FLOYD_KEYCHAIN_ACCOUNTS.management, token);
    return token;
  }
}

function validateAccount(account) {
  if (!Object.values(FLOYD_KEYCHAIN_ACCOUNTS).includes(account)) {
    throw new Error(`unsupported FLOYD Keychain account: ${account}`);
  }
}

// security -i truncates its input line around 4096 bytes; stay well below
// the observed limit so quoting overhead never pushes a value across it.
const INTERACTIVE_LINE_SAFE_LIMIT = 3500;

function interactiveQuote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
