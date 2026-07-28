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
// ---------------------------------------------------------------------------
// Known-benign residue allowlist.
//
// Each entry acknowledges one class of finding that has been manually reviewed
// and is NOT an active credential. Acknowledged findings are reported under
// `acknowledged`/`acknowledgedCount` instead of `outsideVaultCount` so that a
// clean run exits 0 while the evidence remains visible in the report.
//
// Safety rule (enforced in code below, not just by this table): only two
// classes of finding may ever be acknowledged:
//   1. scope "key-shape" patternSuspects — regex-shaped lookalikes that are not
//      exact matches of any credential known to the Vault. An exact match of a
//      real credential is reported separately under `matches` and can never be
//      silenced by this table.
//   2. scope "file" matches whose provider is exactly "openai-oauth-account_id"
//      — the ChatGPT account UUID is an identifier, not a bearer secret; it
//      cannot authenticate anything on its own.
// Real active-key matches (every other provider, and every
// "process-environment" scope finding) are structurally excluded from
// acknowledgment.
const KNOWN_BENIGN = [
  // The OpenAI OAuth account id (a UUID naming the ChatGPT account, not a
  // token) is embedded by Codex itself throughout its own state databases and
  // session transcripts. It is not a secret and cannot be replayed as one.
  {
    pathPattern: new RegExp(`^${homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.codex/`),
    provider: "openai-oauth-account_id",
    scope: "file",
    justification: "Codex writes its own account UUID into ~/.codex sqlite/state files and session logs; it is an identifier, not a credential.",
  },
  // The internal browser profile logged the ChatGPT web session, whose pages
  // include the same account UUID in Local Storage.
  {
    pathPattern: /\/internal-browser-profile\//,
    provider: "openai-oauth-account_id",
    scope: "file",
    justification: "ChatGPT web session persisted the account UUID (an identifier, not a secret) into browser Local Storage.",
  },
  // Browser-profile pattern noise: Chromium history/favicons/autofill/proto
  // stores contain AIza..., hf_..., and tvly-... shaped strings from ordinary
  // web browsing (public Google web API keys baked into pages, docs examples,
  // form-field metadata). Verified not to be exact matches of any Vault-held
  // credential — exact matches are detected independently above.
  ...["google", "huggingface", "tavily"].map((provider) => ({
    pathPattern: /\/internal-browser-profile\//,
    provider,
    scope: "key-shape",
    justification: "Chromium profile stores key-shaped strings from ordinary browsing (public web API keys, autofill/history noise); not exact matches of any Vault credential.",
  })),
  // Codex session transcripts quote key-shaped strings while discussing or
  // scanning for them (including this census's own patterns). Verified not to
  // be exact matches of any Vault-held credential.
  ...["google", "huggingface", "tavily"].map((provider) => ({
    pathPattern: /\/\.codex\/sessions\/.*\.jsonl$/,
    provider,
    scope: "key-shape",
    justification: "Codex session logs quote key-shaped example/scan strings; not exact matches of any Vault credential.",
  })),
  // Codex session transcripts also quote the repo's own openai-shaped test
  // placeholder ("sk-proj-abcdefghijklmnop...") while working on the vault
  // test suite. That literal placeholder is not a credential.
  {
    pathPattern: /\/\.codex\/sessions\/.*\.jsonl$/,
    provider: "openai",
    scope: "key-shape",
    justification: "Codex session logs quote the repo's sk-proj-abcdefghijklmnop... test placeholder from scripts/test/materialize-vault-client-config.test.mjs; not a real key.",
  },
  // One session transcript contains a long base64url blob (an opaque encoded
  // payload) in which "ghp_" + 36 alphanumerics occurs mid-blob, flanked on
  // both sides by more base64url data rather than delimiters. A real PAT is a
  // standalone delimited token; this is a substring coincidence.
  {
    pathPattern: /\/\.codex\/sessions\/.*\.jsonl$/,
    provider: "github",
    scope: "key-shape",
    justification: "ghp_-shaped substring occurs mid base64url blob in a session transcript (continuous encoded data on both sides); coincidence, not a delimited token.",
  },
  // The repo's own vault-client-config test fixture uses an obviously fake
  // sequential placeholder key ("sk-proj-abcdefghijklmnopqrstuvwxyz..."). The
  // FLOYD_RUNTIME release tree carries verbatim copies of the repo.
  {
    pathPattern: /\/scripts\/test\/materialize-vault-client-config\.test\.mjs$/,
    provider: "openai",
    scope: "key-shape",
    justification: "Test fixture placeholder 'sk-proj-abcdefghijklmnopqrstuvwxyzABCDEF...123456' (sequential alphabet, checked in intentionally); not a real key.",
  },
  // floyd-icon.svg embeds a base64 data URI whose encoded bytes happen to
  // contain the substring "AIza" + 35 base64 characters mid-stream.
  {
    pathPattern: /\/apps\/frame\/public\/assets\/floyd-icon\.svg$/,
    provider: "google",
    scope: "key-shape",
    justification: "AIza-shaped substring occurs inside the icon's base64 data URI payload (flanked by continuous base64 on both sides); encoding coincidence, not a key.",
  },
  // Codex's own logs_2.sqlite(-wal) store compressed/encoded blobs whose
  // base64 payloads coincidentally contain AIza...-shaped substrings, and log
  // rows quoting the repo's sk-proj-abcdef... test placeholder. Live database:
  // never edited; acknowledged per-provider after manual strings review.
  ...["google", "openai"].map((provider) => ({
    pathPattern: new RegExp(`^${homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.codex/logs_2\\.sqlite(?:-wal)?$`),
    provider,
    scope: "key-shape",
    justification: "Codex log database blobs contain base64-coincidence AIza substrings and the repo's sk-proj test placeholder; verified via strings review, not real keys.",
  })),
  // The compiled codex plugin-appserver binary's string table concatenates
  // env-var names ("github_pat_" prefix constant + "GH_TOKENGITHUB_TOKEN...")
  // which the github_pat_ regex matches across the concatenation boundary.
  {
    pathPattern: new RegExp(`^${homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.codex/plugins/\\.plugin-appserver/codex$`),
    provider: "github",
    scope: "key-shape",
    justification: "Mach-O string table concatenation ('github_pat_' + 'GH_TOKENGITHUB_TOKEN...') matches the PAT regex across adjacent constants; compiled binary, not a token.",
  },
];

// Only these finding classes may ever be acknowledged. Everything else —
// notably exact matches of live provider keys and process-environment
// findings — must always count as outsideVault regardless of KNOWN_BENIGN.
const ACKNOWLEDGEABLE_FILE_MATCH_PROVIDERS = new Set(["openai-oauth-account_id"]);

function findAcknowledgment(finding) {
  if (finding.scope === "key-shape") {
    // pattern suspects only; eligible by construction
  } else if (finding.scope === "file" && ACKNOWLEDGEABLE_FILE_MATCH_PROVIDERS.has(finding.provider)) {
    // identifier-class fingerprints only
  } else {
    return null;
  }
  for (const entry of KNOWN_BENIGN) {
    if (entry.scope !== finding.scope) continue;
    if (entry.provider !== finding.provider) continue;
    if (typeof finding.path !== "string" || !entry.pathPattern.test(finding.path)) continue;
    return entry;
  }
  return null;
}

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

const acknowledged = [];
const activeMatches = [];
for (const match of matches) {
  const entry = findAcknowledgment(match);
  if (entry) acknowledged.push({ ...match, justification: entry.justification });
  else activeMatches.push(match);
}
const activePatternSuspects = [];
for (const suspect of patternSuspects) {
  const entry = findAcknowledgment(suspect);
  if (entry) acknowledged.push({ ...suspect, justification: entry.justification });
  else activePatternSuspects.push(suspect);
}

const outsideVault = activeMatches.filter((match) => !match.protectedVaultStorage);
console.log(JSON.stringify({
  version: 1,
  filesScanned,
  bytesScanned,
  credentialsCompared: credentials.map(({ provider, fingerprint }) => ({ provider, fingerprint })),
  matches: activeMatches,
  patternSuspects: activePatternSuspects,
  unreadableCount: unreadable.length,
  unreadable: unreadable.slice(0, 50),
  outsideVaultCount: outsideVault.length,
  acknowledgedCount: acknowledged.length,
  acknowledged,
}, null, 2));
process.exitCode = outsideVault.length || activePatternSuspects.length || unreadable.length ? 2 : 0;
