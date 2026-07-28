import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

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
 *
 * Large values (above the `security -i` line limit) are stored as transparent
 * chunks so that NO write path ever places a secret in child argv, where it
 * would be same-user-readable via ps for the duration of the call:
 *
 *   - The primary account holds a manifest marker
 *     `fvchunks:v1:<count>:<sha256-of-full-value>` instead of the value.
 *   - The value is split into <count> pieces of at most CHUNK_PAYLOAD_LIMIT
 *     characters, stored in derived accounts `${account}#0..${count - 1}`,
 *     each written through the same -i stdin path as small values.
 *   - get() detects the marker, reassembles the chunks in order, verifies the
 *     sha256, and returns the full value. A missing chunk or hash mismatch
 *     throws (fail closed) rather than returning a partial secret.
 *
 * Crash-safe swap design (why plain `#<n>` indexes and no generation scheme):
 * the staged-backup envelope captures the FULL previous logical value before
 * any chunk is touched, new chunks are written first, and the manifest is
 * swapped last. Overwriting old chunk indexes in place is therefore safe: a
 * crash mid-write leaves the OLD manifest pointing at chunks whose sha256 no
 * longer matches, which fails closed on read, and recoverStagedWrite()
 * restores the envelope whenever the logical value is unreadable (missing OR
 * corrupt), not only when the primary item is missing. The old value can
 * never be lost before the new one is verifiable because the envelope is
 * verified in place before the first destructive operation. A generation
 * suffix scheme would only avoid the restore-on-mismatch case, at the price
 * of orphaned-generation cleanup; this design keeps cleanup trivial (stale
 * indexes past the new count are deleted after the manifest swap, and any
 * orphans from a crash in that final cleanup are inert because reads are
 * governed by the manifest count).
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
    // If a previous process died between delete-generic-password and
    // add-generic-password, the only copy of that secret is the staged
    // envelope in the migration-backup account. Restore it before anything
    // else touches the Keychain.
    MacOSKeychainVault.recoverStagedWrite(this);
  }

  /**
   * Read the full logical value for an account. Chunked values (manifest
   * marker in the primary item) are reassembled and integrity-checked; a
   * missing chunk or hash mismatch throws instead of returning partial data.
   */
  get(account) {
    validateAccount(account);
    const raw = this.#rawGet(account);
    if (raw === null) return null;
    // Chunk accounts themselves (`x#0`) never nest another manifest level.
    const manifest = account.includes("#") ? null : parseChunkManifest(raw);
    if (!manifest) return raw;
    const parts = [];
    for (let index = 0; index < manifest.count; index += 1) {
      const chunkAccount = `${account}#${index}`;
      const chunk = this.#rawGet(chunkAccount);
      if (chunk === null) {
        throw new Error(
          `macOS Keychain chunk ${chunkAccount} is missing; refusing to return a partial secret for ${account}`,
        );
      }
      parts.push(chunk);
    }
    const full = parts.join("");
    if (sha256Hex(full) !== manifest.hash) {
      throw new Error(`macOS Keychain chunked value failed integrity verification for ${account}`);
    }
    return full;
  }

  set(account, secret) {
    validateAccount(account);
    if (typeof secret !== "string" || !secret) throw new Error("Keychain secret must be a non-empty string");
    if (/[\r\n]/.test(secret)) throw new Error("Keychain secret must be a single line");
    if (parseChunkManifest(secret)) {
      // The manifest marker namespace is reserved; storing a literal marker
      // as a value would make get() misinterpret it as chunk metadata.
      throw new Error("Keychain secret uses the reserved fvchunks manifest prefix");
    }
    const backupAccount = FLOYD_KEYCHAIN_ACCOUNTS.migrationBackups;
    let staged = false;
    if (account !== backupAccount) {
      // Crash safety: delete-then-create has a window where the process can
      // die with the item deleted but not yet re-created, and the Keychain is
      // the ONLY storage for these secrets. Stage the old FULL LOGICAL value
      // (reassembled from chunks when applicable, never the manifest string)
      // in the backup account first; recoverStagedWrite() replays it at
      // startup if the swap never completed or left the chunked value
      // unreadable. The backup account itself is written without staging (it
      // IS the backup), which also breaks the recursion.
      const existing = this.get(account);
      if (existing !== null) {
        this.#writeLogical(backupAccount, JSON.stringify({
          account,
          value: existing,
          staged_at: new Date().toISOString(),
        }));
        staged = true;
      }
    }
    this.#writeLogical(account, secret);
    if (staged) {
      // The new value is verified in place, so the staged copy is spent.
      this.delete(backupAccount);
    }
  }

  /**
   * Write the full logical value for an account, chunking transparently when
   * it exceeds the -i stdin limit. Ordering is the crash-safety contract
   * described on the class: chunks first, manifest swap last, stale-chunk
   * cleanup only after the swap. Finishes with a read-back verification of
   * the FULL logical value.
   */
  #writeLogical(account, secret) {
    // Snapshot the old manifest (if any) so stale chunk indexes past the new
    // count can be cleaned up after the swap.
    const before = this.#rawGet(account);
    const beforeManifest = before === null || account.includes("#")
      ? null
      : parseChunkManifest(before);
    let newChunkCount = 0;
    if (secret.length <= INTERACTIVE_LINE_SAFE_LIMIT) {
      this.#writeRaw(account, secret);
    } else {
      const chunks = splitIntoChunks(secret);
      newChunkCount = chunks.length;
      // Chunks first: while these writes are in flight the primary item still
      // holds the OLD manifest, whose sha256 no longer matches once any chunk
      // index is overwritten, so a concurrent crash fails closed on read and
      // is restored from the staged envelope at next startup.
      for (let index = 0; index < chunks.length; index += 1) {
        this.#writeRaw(`${account}#${index}`, chunks[index]);
      }
      // Manifest swap last: this is the atomic-ish commit point. Before it,
      // reads resolve (or fail closed) against the old value; after it, all
      // chunks are already in place and verified.
      this.#writeRaw(account, `${CHUNK_MANIFEST_PREFIX}${chunks.length}:${sha256Hex(secret)}`);
    }
    // Cleanup after the swap: stale chunk indexes from a previously larger
    // value. Reads are governed by the manifest count, so a crash that skips
    // this cleanup only leaks inert (still encrypted-at-rest) leftovers that
    // the next write or delete() removes.
    let staleIndex = newChunkCount;
    const knownOldCount = beforeManifest ? beforeManifest.count : 0;
    for (; staleIndex < knownOldCount; staleIndex += 1) {
      this.#rawDelete(`${account}#${staleIndex}`);
    }
    for (; this.#rawDelete(`${account}#${staleIndex}`); staleIndex += 1) {
      // Probe past the known range in case an earlier crash left extras.
    }
    // Full-logical read-back verification (both security input modes have
    // silent-truncation failure shapes that exit 0). get() also enforces the
    // chunk sha256, so this verifies the entire reassembled value.
    const written = this.get(account);
    if (written !== secret) {
      throw new Error(`macOS Keychain write verification failed for ${account}`);
    }
  }

  /**
   * The raw swap for a single Keychain item: delete-then-create plus
   * read-back verification, with no staging or chunking. Updating an existing
   * item (-U) rewrites its ACL, and SecKeychainItemSetAccess prompts the user
   * for the login password every time. Creating a fresh item sets the ACL
   * silently, so never use -U here.
   *
   * SECURITY INVARIANT: the secret travels ONLY on stdin (`security -i`
   * consumes the full command line from stdin), never in child argv, which is
   * same-user-readable via ps. Callers must pre-chunk anything larger than
   * the -i line limit; there is deliberately NO argv fallback.
   */
  #writeRaw(account, secret) {
    if (secret.length > INTERACTIVE_LINE_SAFE_LIMIT) {
      throw new Error(`internal: raw Keychain write for ${account} exceeds the interactive stdin limit`);
    }
    this.#rawDelete(account);
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
    // Per-item read-back verification; #writeLogical additionally verifies
    // the full reassembled value for chunked writes.
    const written = this.#rawGet(account);
    if (written !== secret) {
      throw new Error(`macOS Keychain write verification failed for ${account}`);
    }
  }

  /**
   * Replay a write that crashed mid-swap. Runs automatically at construction;
   * safe to call again at any time (idempotent, returns the restored account
   * or null). Restores whenever the target's logical value is missing OR
   * unreadable (missing chunk / hash mismatch), which is what a crash between
   * chunk writes and the manifest swap looks like.
   */
  static recoverStagedWrite(vault) {
    const backupAccount = FLOYD_KEYCHAIN_ACCOUNTS.migrationBackups;
    let raw;
    try {
      raw = vault.get(backupAccount);
    } catch {
      // The envelope itself is unreadable (missing chunk / hash mismatch).
      // Envelopes are fully written AND verified before the target swap
      // begins, so a partial envelope proves the target was never touched.
      // The partial stage is safe to discard.
      vault.delete(backupAccount);
      return null;
    }
    if (raw === null) return null;
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      // Not a staged envelope (the account is also usable as scratch space);
      // leave unfamiliar data alone.
      return null;
    }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
    const { account, value } = envelope;
    if (typeof account !== "string" || typeof value !== "string" || !value) return null;
    if (!Object.values(FLOYD_KEYCHAIN_ACCOUNTS).includes(account) || account === backupAccount) {
      return null;
    }
    let intact = false;
    try {
      intact = vault.get(account) !== null;
    } catch {
      // Manifest present but chunks missing/corrupt: the crash landed between
      // chunk writes and the manifest swap. The staged copy is authoritative.
      intact = false;
    }
    let restored = null;
    if (!intact) {
      // The crash left the target missing or unreadable. The staged copy is
      // the only surviving full value.
      MacOSKeychainVault.#restore(vault, account, value);
      restored = account;
    }
    // Either we just restored it or the newer write completed (target
    // readable) and only the cleanup was lost. The envelope is spent.
    vault.delete(backupAccount);
    return restored;
  }

  // Indirection so the static recovery path can reach the private writer.
  static #restore(vault, account, value) {
    vault.#writeLogical(account, value);
  }

  /**
   * Delete the full logical value: the primary item (value or manifest) plus
   * every chunk. Chunks are removed via the manifest count when available,
   * then by probing successive indexes until a miss, which also sweeps
   * leftovers from interrupted cleanups of contiguous ranges.
   */
  delete(account) {
    validateAccount(account);
    const raw = this.#rawGet(account);
    const manifest = raw === null || account.includes("#") ? null : parseChunkManifest(raw);
    let removed = false;
    if (raw !== null) removed = this.#rawDelete(account) || removed;
    if (!account.includes("#")) {
      let index = 0;
      const knownCount = manifest ? manifest.count : 0;
      for (; index < knownCount; index += 1) {
        removed = this.#rawDelete(`${account}#${index}`) || removed;
      }
      for (; ; index += 1) {
        if (!this.#rawDelete(`${account}#${index}`)) break;
        removed = true;
      }
    }
    return removed;
  }

  #rawGet(account) {
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

  #rawDelete(account) {
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

/**
 * Accept the fixed allowlist plus derived chunk accounts of the form
 * `<allowed-account>#<integer>`. Arbitrary accounts stay rejected.
 */
function validateAccount(account) {
  const allowed = Object.values(FLOYD_KEYCHAIN_ACCOUNTS);
  if (allowed.includes(account)) return;
  const chunkMatch = typeof account === "string" ? account.match(/^(.+)#(\d+)$/) : null;
  if (chunkMatch && allowed.includes(chunkMatch[1])) return;
  throw new Error(`unsupported FLOYD Keychain account: ${account}`);
}

// security -i truncates its input line around 4096 bytes; stay well below
// the observed limit so quoting overhead never pushes a value across it.
const INTERACTIVE_LINE_SAFE_LIMIT = 3500;

// Chunk payload size for values above the -i limit: 3000 leaves quoting
// headroom (command scaffolding plus escaping) under the 4096 truncation.
const CHUNK_PAYLOAD_LIMIT = 3000;

// Manifest marker stored in the primary account of a chunked value:
// fvchunks:v1:<count>:<sha256-of-full-value>
const CHUNK_MANIFEST_PREFIX = "fvchunks:v1:";
const CHUNK_MANIFEST_PATTERN = /^fvchunks:v1:(\d+):([0-9a-f]{64})$/;

function parseChunkManifest(raw) {
  const match = typeof raw === "string" ? raw.match(CHUNK_MANIFEST_PATTERN) : null;
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count) || count < 1) return null;
  return { count, hash: match[2] };
}

function splitIntoChunks(secret) {
  const chunks = [];
  let start = 0;
  while (start < secret.length) {
    let end = Math.min(start + CHUNK_PAYLOAD_LIMIT, secret.length);
    // Never split a surrogate pair across chunks: lone surrogates do not
    // survive the UTF-8 round trip through security, which would trip the
    // read-back verification.
    if (end < secret.length) {
      const code = secret.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    chunks.push(secret.slice(start, end));
    start = end;
  }
  return chunks;
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function interactiveQuote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
