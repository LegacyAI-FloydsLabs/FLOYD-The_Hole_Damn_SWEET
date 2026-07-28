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
    this.exec("/usr/bin/security", [
      "add-generic-password",
      "-U",
      "-a", account,
      "-s", this.service,
      "-D", "application password",
      "-T", "",
      // Keep -w last with no argv value. The security tool reads stdin, so
      // the secret is not exposed in the child process command line.
      "-w",
    ], {
      encoding: "utf8",
      input: `${secret}\n`,
      stdio: ["pipe", "pipe", "pipe"],
    });
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
