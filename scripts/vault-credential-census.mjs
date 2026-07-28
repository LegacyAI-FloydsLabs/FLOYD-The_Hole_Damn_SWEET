#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  lstatSync,
  readFileSync,
  readSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  FLOYD_KEYCHAIN_ACCOUNTS,
  MacOSKeychainVault,
} from "../apps/frame/server/keychain-vault.mjs";
import { readVaultMigrationBackupEntry } from "./lib/vault-migration-transaction.mjs";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const runtimeRoot = process.env.FLOYD_RUNTIME_ROOT || "/Volumes/Storage/FLOYD_RUNTIME";
const legacyVaultPath = join(runtimeRoot, "secrets", "provider-keys.json");
const legacyAuthPath = join(homedir(), ".codex", "auth.json");
const keychain = new MacOSKeychainVault();
const keychainProviderState = keychain.get(FLOYD_KEYCHAIN_ACCOUNTS.providers);
const vault = keychainProviderState === null && existsSync(legacyVaultPath)
  ? JSON.parse(readFileSync(legacyVaultPath, "utf8"))
  : keychainProviderState === null ? {} : JSON.parse(keychainProviderState);
const keychainSubscriptionState = keychain.get(FLOYD_KEYCHAIN_ACCOUNTS.subscription);
const subscription = keychainSubscriptionState === null && existsSync(legacyAuthPath)
  ? JSON.parse(readFileSync(legacyAuthPath, "utf8"))
  : keychainSubscriptionState === null ? {} : JSON.parse(keychainSubscriptionState);
const remoteMcp = keychain.readJson(
  FLOYD_KEYCHAIN_ACCOUNTS.remoteMcpTargets,
  { version: 1, targets: {} },
);
const credentials = Object.entries(vault)
  .filter(([, entry]) => typeof entry?.key === "string" && entry.key)
  .map(([provider, entry]) => ({
    provider,
    value: entry.key,
    fingerprint: createHash("sha256").update(entry.key).digest("hex").slice(0, 12),
  }));
for (const [name, value] of Object.entries(subscription.tokens || {})) {
  if (typeof value !== "string" || value.length < 12) continue;
  credentials.push({
    provider: `openai-oauth-${name}`,
    value,
    fingerprint: createHash("sha256").update(value).digest("hex").slice(0, 12),
  });
}
for (const [targetId, target] of Object.entries(remoteMcp.targets || {})) {
  for (const [header, value] of Object.entries(target?.headers || {})) {
    if (typeof value !== "string" || value.length < 12) continue;
    credentials.push({
      provider: `mcp-${targetId}-${header.toLowerCase()}`,
      value,
      fingerprint: createHash("sha256").update(value).digest("hex").slice(0, 12),
    });
  }
}
const historicalFingerprints = new Set(credentials.map(({ fingerprint }) => fingerprint));
const backupKeys = keychain.readJson(FLOYD_KEYCHAIN_ACCOUNTS.migrationBackups);
for (const [migrationId, encodedKey] of Object.entries(backupKeys)) {
  const manifestPath = join(runtimeRoot, "migration-backups", migrationId, "manifest.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const backupKey = Buffer.from(String(encodedKey), "base64");
  for (const entry of manifest.entries || []) {
    if (!entry?.existed || !/(?:provider-keys\.json|auth\.json)$/.test(String(entry.path))) continue;
    const plaintext = readVaultMigrationBackupEntry(entry, backupKey);
    if (!plaintext) continue;
    try {
      const document = JSON.parse(plaintext.toString("utf8"));
      const candidates = entry.path.endsWith("provider-keys.json")
        ? Object.entries(document).map(([provider, value]) => [provider, value?.key])
        : Object.entries(document.tokens || {}).map(([name, value]) => [`openai-oauth-${name}`, value]);
      for (const [provider, value] of candidates) {
        if (typeof value !== "string" || value.length < 12 || value.startsWith("fv_")) continue;
        const fingerprint = createHash("sha256").update(value).digest("hex").slice(0, 12);
        if (historicalFingerprints.has(fingerprint)) continue;
        historicalFingerprints.add(fingerprint);
        credentials.push({ provider: `historical-${provider}`, value, fingerprint });
      }
    } finally {
      plaintext.fill(0);
    }
  }
}

const roots = [
  repoRoot,
  runtimeRoot,
  join(homedir(), ".floyd"),
  join(homedir(), ".floyd-agents"),
  join(homedir(), ".codex"),
  join(homedir(), ".omp"),
  join(homedir(), ".local", "share", "floyd"),
  join(homedir(), ".local", "share", "opencode"),
  join(homedir(), ".config", "opencode"),
  join(homedir(), "Library", "Application Support", "Floyd"),
  join(homedir(), "Library", "Application Support", "CURSEM"),
  join(homedir(), "Library", "Logs", "floyd"),
].filter((path, index, values) => existsSync(path) && values.indexOf(path) === index);

const excludedNames = new Set([".git", "node_modules", "Cache", "Code Cache", "GPUCache"]);
const allowedBinaryNames = new Set(["CURRENT", "LOG", "MANIFEST"]);
const matches = [];
const patternSuspects = [];
const unreadable = [];
let filesScanned = 0;
let bytesScanned = 0;
const providerPatterns = [
  ["anthropic", /sk-ant-api\d{2}-[A-Za-z0-9_-]{60,}/g],
  ["openai", /sk-(?:proj|svcacct)-[A-Za-z0-9_-]{40,}/g],
  ["google", /AIza[A-Za-z0-9_-]{35}/g],
  ["github", /(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})/g],
  ["groq", /gsk_[A-Za-z0-9]{40,}/g],
  ["openrouter", /sk-or-v1-[a-f0-9]{60,}/g],
  ["xai", /xai-[A-Za-z0-9_-]{40,}/g],
  ["tavily", /tvly-[A-Za-z0-9_-]{24,}/g],
  ["huggingface", /hf_[A-Za-z0-9]{30,}/g],
  ["minimax", /sk-cp-[A-Za-z0-9_-]{32,}/g],
];

function scan(path) {
  let metadata;
  try { metadata = lstatSync(path); } catch { return; }
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    if (excludedNames.has(path.split("/").at(-1))) return;
    let children;
    try { children = readdirSync(path); } catch (error) {
      unreadable.push({ path, operation: "readdir", code: error?.code || "ERROR" });
      return;
    }
    for (const child of children) scan(join(path, child));
    return;
  }
  if (!metadata.isFile()) return;
  const name = path.split("/").at(-1) || "";
  if (!allowedBinaryNames.has(name) && /\.(?:png|jpe?g|gif|webp|tiff?|woff2?|ttf|zip|gz|tgz|pdf|dylib|node)$/i.test(name)) return;
  let descriptor;
  try { descriptor = openSync(path, "r"); } catch (error) {
    unreadable.push({ path, operation: "open", code: error?.code || "ERROR" });
    return;
  }
  filesScanned += 1;
  const exactCounts = new Map();
  const patternCounts = new Map();
  const maxCredentialBytes = Math.max(0, ...credentials.map(({ value }) => Buffer.byteLength(value)));
  const overlapSize = Math.max(1024, maxCredentialBytes - 1);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let overlap = Buffer.alloc(0);
  try {
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytesScanned += bytesRead;
      const data = Buffer.concat([overlap, buffer.subarray(0, bytesRead)]);
      for (const credential of credentials) {
        const needle = Buffer.from(credential.value);
        let offset = 0;
        let count = 0;
        while ((offset = data.indexOf(needle, offset)) >= 0) {
          count += 1;
          offset += needle.length;
        }
        if (count) exactCounts.set(credential, (exactCounts.get(credential) || 0) + count);
      }
      const text = data.toString("latin1");
      for (const [provider, pattern] of providerPatterns) {
        pattern.lastIndex = 0;
        const count = Array.from(text.matchAll(pattern)).length;
        if (count) patternCounts.set(provider, (patternCounts.get(provider) || 0) + count);
      }
      overlap = data.subarray(Math.max(0, data.length - overlapSize));
    }
  } catch (error) {
    unreadable.push({ path, operation: "read", code: error?.code || "ERROR" });
  } finally {
    closeSync(descriptor);
  }
  for (const [credential, count] of exactCounts) {
    matches.push({
      scope: "file",
      provider: credential.provider,
      fingerprint: credential.fingerprint,
      path,
      count,
      protectedVaultStorage: false,
    });
  }
  for (const [provider, count] of patternCounts) {
    patternSuspects.push({ scope: "key-shape", provider, path, count });
  }
}

for (const root of roots) scan(root);

try {
  const processes = execFileSync("ps", ["eww", "-axo", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const line of processes.split("\n")) {
    const pid = Number(line.trim().split(/\s+/, 1)[0]);
    if (!pid || pid === process.pid) continue;
    for (const credential of credentials) {
      if (line.includes(credential.value)) matches.push({
        scope: "process-environment",
        provider: credential.provider,
        fingerprint: credential.fingerprint,
        pid,
        count: line.split(credential.value).length - 1,
        protectedVaultStorage: false,
      });
    }
  }
} catch {
  // Some hardened environments do not expose other process environments.
}

const outsideVault = matches.filter((match) => !match.protectedVaultStorage);
console.log(JSON.stringify({
  version: 1,
  filesScanned,
  bytesScanned,
  credentialsCompared: credentials.map(({ provider, fingerprint }) => ({ provider, fingerprint })),
  matches,
  patternSuspects,
  unreadableCount: unreadable.length,
  unreadable: unreadable.slice(0, 50),
  outsideVaultCount: outsideVault.length,
}, null, 2));
process.exitCode = outsideVault.length || patternSuspects.length || unreadable.length ? 2 : 0;
