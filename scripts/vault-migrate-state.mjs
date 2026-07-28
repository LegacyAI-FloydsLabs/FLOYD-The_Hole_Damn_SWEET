#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildFloydProviderConfig,
  readVaultAppProfile,
} from "../lib/vault-routing.mjs";
import {
  FLOYD_KEYCHAIN_ACCOUNTS,
  MacOSKeychainVault,
} from "../apps/frame/server/keychain-vault.mjs";
import { createVaultMcpManagement } from "../apps/frame/server/vault-mcp-management.mjs";
import {
  planVaultMcpMigration,
  reconcileVaultMcpProviderCredentials,
} from "../lib/vault-mcp-migration.mjs";
import { migrateConnectedAppState } from "./lib/connected-app-migration.mjs";
import { migrateModelConnectorState } from "./lib/model-connector-migration.mjs";
import {
  inspectOmfCredentialStore,
  lockOmfCredentialStore,
} from "./lib/omf-credential-store.mjs";
import { verifyCoreDatabaseSupersedes } from "./lib/sqlite-superset.mjs";
import { VaultMigrationTransaction } from "./lib/vault-migration-transaction.mjs";

const apply = process.argv.includes("--apply");
const runtimeRoot = process.env.FLOYD_RUNTIME_ROOT || "/Volumes/Storage/FLOYD_RUNTIME";
const vaultPath = join(runtimeRoot, "secrets", "provider-keys.json");
const legacyVaultPath = join(homedir(), ".floyd", "secrets", "provider-keys.json");
const chatgptAuthPath = join(homedir(), ".codex", "auth.json");
const primaryCoreRoot = join(runtimeRoot, "core");
const legacyCoreRoot = join(homedir(), ".floyd", "core");
const coreDatabase = join(primaryCoreRoot, "floyd.db");
const legacyCoreDatabase = join(legacyCoreRoot, "floyd.db");
const connectedAppMasterKey = join(primaryCoreRoot, "connected-app-master.key");
const legacyConnectedAppMasterKey = join(legacyCoreRoot, "connected-app-master.key");
const connectorMasterKey = join(primaryCoreRoot, "connector-master.key");
const legacyConnectorMasterKey = join(legacyCoreRoot, "connector-master.key");
const omfDatabase = join(homedir(), ".omp", "agent", "agent.db");
const openCodeAuthPath = join(homedir(), ".local", "share", "opencode", "auth.json");
const vault = JSON.parse(readFileSync(vaultPath, "utf8"));
const realKeys = new Map(Object.entries(vault)
  .filter(([, entry]) => typeof entry?.key === "string" && entry.key)
  .map(([provider, entry]) => [provider, entry.key]));
const knownValues = new Set(realKeys.values());
const rehearsalRoot = mkdtempSync(join(tmpdir(), "floyd-vault-migration-rehearsal-"));
const conflicts = [];
const receipts = [];
let transaction = null;
let keychain = null;

function chatgptSubscriptionConfigured() {
  try {
    const auth = JSON.parse(readFileSync(chatgptAuthPath, "utf8"));
    return Boolean(auth?.tokens?.access_token && auth?.tokens?.refresh_token);
  } catch {
    return false;
  }
}

function isLegacyEnvironmentReference(value) {
  return /^\{env:[A-Z][A-Z0-9_]*\}$/.test(value);
}

function profile(app, fallbackToken) {
  const path = join(runtimeRoot, "secrets", "proxy-app-profiles", `${app}.json`);
  if (!apply && !existsSync(path)) {
    return {
      app,
      token: fallbackToken,
      proxy: "http://127.0.0.1:13031",
    };
  }
  return readVaultAppProfile(readFileSync(path, "utf8"), app);
}

const launcher = profile("launcher", "fv_launcher_0123456789abcdef0123456789abcdef0123456789abcdef");
const core = profile("core", "fv_core_0123456789abcdef0123456789abcdef0123456789abcdef");

function atomicJson(path, value) {
  if (apply) transaction?.backup(path);
  const temporary = `${path}.vault-migrate.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function atomicText(path, text) {
  if (apply) transaction?.backup(path);
  const temporary = `${path}.vault-migrate.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function copyForRehearsal(source, category) {
  const targetDirectory = join(rehearsalRoot, category);
  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 12);
  const target = join(targetDirectory, `${digest}-${basename(source)}`);
  copyFileSync(source, target);
  chmodSync(target, 0o600);
  return target;
}

function findAgentConfigs() {
  const root = join(homedir(), ".floyd-agents");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => join(root, name, "config", "floyd.json"))
    .filter(existsSync);
}

function findCursemDatabases() {
  const root = join(homedir(), "Library", "Application Support", "CURSEM");
  const found = [];
  function walk(path, depth) {
    if (depth > 6 || !existsSync(path)) return;
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) return;
    if (metadata.isFile()) {
      if (path.endsWith(".sqlite") || path.endsWith(".db")) found.push(path);
      return;
    }
    for (const child of readdirSync(path)) walk(join(path, child), depth + 1);
  }
  walk(root, 0);
  return found;
}

function findMcpConfigs() {
  return [
    { path: join(homedir(), ".cursem", "mcp.json"), apps: ["cursem"] },
    { path: join(process.cwd(), ".cursor", "mcp.json"), apps: ["cursem"] },
    { path: join(process.cwd(), ".cursem", "mcp.json"), apps: ["cursem"] },
    { path: join(homedir(), ".omp", "agent", "mcp.json"), apps: ["omf"] },
    { path: join(homedir(), ".omp", "agent", ".mcp.json"), apps: ["omf"] },
  ].filter((entry, index, all) => existsSync(entry.path)
    && all.findIndex((candidate) => candidate.path === entry.path) === index);
}

function putNewKeychainString(account, value) {
  const existing = keychain.get(account);
  if (existing !== null) {
    if (existing !== value) {
      throw new Error(`Keychain account ${account} already contains different state`);
    }
    return false;
  }
  keychain.set(account, value);
  transaction.recordCreatedKeychainAccount(account);
  return true;
}

function putNewKeychainJson(account, value) {
  return putNewKeychainString(account, JSON.stringify(value));
}

function validateProviderCredentials(config, source) {
  for (const [provider, entry] of Object.entries(config.providers || {})) {
    const value = entry?.api_key ?? entry?.apiKey;
    if (typeof value !== "string" || !value || value.startsWith("fv_")) continue;
    if (knownValues.has(value)) continue;
    conflicts.push({ source, provider, reason: "credential differs from the active Vault value" });
  }
}

function migrateAgent(source) {
  const target = apply ? source : copyForRehearsal(source, "agents");
  const before = JSON.parse(readFileSync(target, "utf8"));
  validateProviderCredentials(before, source);
  if (conflicts.length) return;
  const after = clone(before);
  const managed = buildFloydProviderConfig(launcher.token, launcher.proxy);
  after.providers = Object.fromEntries(Object.entries(managed).map(([provider, route]) => [
    provider,
    { ...(before.providers?.[provider] || {}), ...route },
  ]));
  const beforeUnrelated = clone(before); delete beforeUnrelated.providers;
  const afterUnrelated = clone(after); delete afterUnrelated.providers;
  if (JSON.stringify(beforeUnrelated) !== JSON.stringify(afterUnrelated)) throw new Error(`unrelated agent settings changed: ${source}`);
  atomicJson(target, after);
  receipts.push({ category: "agent", source, result: "providers-replaced", unrelatedSettingsPreserved: true });
}

function walkObject(value, visitor, path = []) {
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    visitor(value, key, path);
    walkObject(value[key], visitor, [...path, key]);
  }
}

function validateOpenCodeCredentials(source) {
  const config = JSON.parse(readFileSync(source, "utf8"));
  walkObject(config, (parent, key, path) => {
    if (!["apiKey", "api_key"].includes(key) || typeof parent[key] !== "string") return;
    const value = parent[key];
    if (!value || value.startsWith("fv_") || knownValues.has(value)
      || isLegacyEnvironmentReference(value)) return;
    conflicts.push({
      source,
      provider: path.join("."),
      reason: "credential differs from the active Vault value",
    });
  });
}

function migrateOpenCode(source, managedRuntime) {
  const target = apply ? source : copyForRehearsal(source, "opencode");
  const before = JSON.parse(readFileSync(target, "utf8"));
  const after = clone(before);
  walkObject(after, (parent, key, path) => {
    if (!["apiKey", "api_key"].includes(key) || typeof parent[key] !== "string") return;
    const value = parent[key];
    if (value.startsWith("fv_")) return;
    if (!knownValues.has(value) && !isLegacyEnvironmentReference(value)) {
      conflicts.push({ source, provider: path.join("."), reason: "credential differs from the active Vault value" });
      return;
    }
    if (managedRuntime) parent[key] = core.token;
    else delete parent[key];
  });
  if (conflicts.length) return;
  if (managedRuntime) {
    after.provider = {
      "zai-coding-plan": {
        options: {
          apiKey: core.token,
          baseURL: `${core.proxy}/p/zai/api/coding/paas/v4`,
        },
      },
    };
  }
  atomicJson(target, after);
  receipts.push({ category: "opencode", source, result: managedRuntime ? "vault-route-installed" : "copied-vault-key-removed" });
}

function inspectOpenCodeAuth(source) {
  const document = JSON.parse(readFileSync(source, "utf8"));
  walkObject(document, (parent, key, path) => {
    if (!/^(?:api_?key|key|token|access_?token|refresh_?token|client_?secret)$/i.test(key)
      || typeof parent[key] !== "string" || !parent[key]) return;
    const value = parent[key];
    if (value.startsWith("fv_") || knownValues.has(value) || isLegacyEnvironmentReference(value)) return;
    conflicts.push({
      source,
      provider: path.join("."),
      reason: "OpenCode auth credential differs from the active Vault value",
    });
  });
}

function migrateOpenCodeAuth(source) {
  const target = apply ? source : copyForRehearsal(source, "opencode-auth");
  const before = JSON.parse(readFileSync(target, "utf8"));
  const after = clone(before);
  walkObject(after, (parent, key) => {
    if (!/^(?:api_?key|key|token|access_?token|refresh_?token|client_?secret)$/i.test(key)
      || typeof parent[key] !== "string") return;
    if (parent[key].startsWith("fv_") || knownValues.has(parent[key])
      || isLegacyEnvironmentReference(parent[key])) delete parent[key];
  });
  atomicJson(target, after);
  receipts.push({
    category: "opencode-auth",
    source,
    result: "credential fields removed from OpenCode data store; unrelated fields preserved",
  });
}

function migrateDesktop(source) {
  const target = apply ? source : copyForRehearsal(source, "desktop");
  const before = JSON.parse(readFileSync(target, "utf8"));
  const after = clone(before);
  for (const key of ["apiKey", "baseURL", "baseUrl"]) {
    if (key === "apiKey" && typeof after[key] === "string" && after[key]
      && !after[key].startsWith("fv_") && !knownValues.has(after[key])) {
      conflicts.push({ source, provider: String(after.provider || "desktop"), reason: "credential differs from the active Vault value" });
    }
    delete after[key];
  }
  if (conflicts.length) return;
  atomicJson(target, after);
  receipts.push({ category: "desktop", source, result: "obsolete-direct-fields-removed" });
}

function databaseDigest(databasePath, excludedPrefixes = []) {
  // Ordinary read-only mode includes committed WAL pages. immutable=1 would
  // silently compare an older main-file snapshot while a live app is open.
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map((row) => String(row.name)).filter((name) => !excludedPrefixes.some((prefix) => name.startsWith(prefix)));
    const hash = createHash("sha256");
    for (const table of tables) {
      hash.update(table);
      const safe = table.replaceAll('"', '""');
      hash.update(JSON.stringify(database.prepare(`SELECT * FROM "${safe}" ORDER BY rowid`).all()));
    }
    return hash.digest("hex");
  } finally {
    database.close();
  }
}

function rehearseDatabase(source, category, mutate) {
  const target = join(rehearsalRoot, category, `${createHash("sha256").update(source).digest("hex").slice(0, 12)}-${basename(source)}`);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  execFileSync("/usr/bin/sqlite3", [source, `.backup '${target.replaceAll("'", "''")}'`]);
  chmodSync(target, 0o600);
  mutate?.(target);
  return target;
}

const agentConfigs = findAgentConfigs();
const openCodeFiles = [
  [join(runtimeRoot, "engines", "opencode", "config", "opencode.json"), true],
  [join(homedir(), ".floyd", "engines", "opencode", "config", "opencode.json"), false],
  [join(homedir(), ".config", "opencode", "opencode.json"), false],
].filter(([path]) => existsSync(path));
const openCodeAuthFiles = [openCodeAuthPath].filter(existsSync);
const desktopSettings = join(runtimeRoot, "desktop-data", "settings.json");
const mcpPlans = findMcpConfigs()
  .map(({ path: sourcePath, apps }) => planVaultMcpMigration({
    sourcePath,
    apps,
    text: readFileSync(sourcePath, "utf8"),
  }))
  .filter((plan) => plan.changed);
let plannedMcpCredentials = [];
try {
  plannedMcpCredentials = reconcileVaultMcpProviderCredentials(mcpPlans, vault);
} catch (error) {
  conflicts.push({ source: "MCP configuration set", reason: error.message });
}

// Complete the conflict scan before any --apply write. This makes a conflict
// an all-or-nothing stop instead of allowing an earlier target to be rewritten.
for (const source of agentConfigs) {
  validateProviderCredentials(JSON.parse(readFileSync(source, "utf8")), source);
}
for (const [source] of openCodeFiles) validateOpenCodeCredentials(source);
for (const source of openCodeAuthFiles) inspectOpenCodeAuth(source);
const omfCredentialState = inspectOmfCredentialStore(omfDatabase);
for (const row of omfCredentialState.rows) {
  if (!row.secrets.length) {
    conflicts.push({
      source: omfDatabase,
      provider: row.provider,
      reason: `OMF ${row.credentialType} credential could not be safely identified`,
    });
    continue;
  }
  for (const value of row.secrets) {
    if (!value.startsWith("fv_") && !knownValues.has(value)) {
      conflicts.push({
        source: omfDatabase,
        provider: row.provider,
        reason: "OMF credential differs from the active Vault value",
      });
    }
  }
}
if (existsSync(desktopSettings)) {
  const settings = JSON.parse(readFileSync(desktopSettings, "utf8"));
  if (typeof settings.apiKey === "string" && settings.apiKey
    && !settings.apiKey.startsWith("fv_") && !knownValues.has(settings.apiKey)) {
    conflicts.push({
      source: desktopSettings,
      provider: String(settings.provider || "desktop"),
      reason: "credential differs from the active Vault value",
    });
  }
}
if (existsSync(legacyVaultPath) && legacyVaultPath !== vaultPath) {
  const legacy = JSON.parse(readFileSync(legacyVaultPath, "utf8"));
  for (const [provider, entry] of Object.entries(legacy)) {
    if (entry?.key && entry.key !== realKeys.get(provider)) {
      conflicts.push({
        source: legacyVaultPath,
        provider,
        reason: "legacy Vault contains a different credential",
      });
    }
  }
}
if (vault.openai?.key && !chatgptSubscriptionConfigured()) {
  conflicts.push({
    source: vaultPath,
    provider: "openai",
    reason: "OpenAI API key cannot be removed until the ChatGPT subscription is configured",
  });
}
if (existsSync(legacyCoreDatabase)) {
  const supersession = existsSync(coreDatabase)
    ? verifyCoreDatabaseSupersedes(coreDatabase, legacyCoreDatabase)
    : { ok: false, failures: ["active Core database is missing"] };
  if (!supersession.ok) {
    conflicts.push({
      source: legacyCoreDatabase,
      reason: `active Core database does not safely supersede the legacy database: ${supersession.failures.join("; ")}`,
    });
  }
}
for (const [active, legacy, label] of [
  [connectedAppMasterKey, legacyConnectedAppMasterKey, "connected-app master key"],
  [connectorMasterKey, legacyConnectorMasterKey, "connector master key"],
]) {
  if (!existsSync(legacy)) continue;
  if (!existsSync(active)
    || createHash("sha256").update(readFileSync(active)).digest("hex")
      !== createHash("sha256").update(readFileSync(legacy)).digest("hex")) {
    conflicts.push({ source: legacy, reason: `legacy ${label} differs from the active runtime` });
  }
}
if (conflicts.length) {
  console.log(JSON.stringify({ mode: apply ? "apply" : "rehearsal", ok: false, conflicts }, null, 2));
  process.exit(3);
}

if (apply) {
  keychain = new MacOSKeychainVault();
  const backupKey = randomBytes(32);
  transaction = new VaultMigrationTransaction({
    backupRoot: join(runtimeRoot, "migration-backups"),
    backupKey,
  });
  const keys = keychain.readJson(FLOYD_KEYCHAIN_ACCOUNTS.migrationBackups);
  keys[transaction.manifest.id] = backupKey.toString("base64");
  keychain.writeJson(FLOYD_KEYCHAIN_ACCOUNTS.migrationBackups, keys);
}

try {
for (const agent of agentConfigs) migrateAgent(agent);
for (const [path, managed] of openCodeFiles) migrateOpenCode(path, managed);
for (const path of openCodeAuthFiles) migrateOpenCodeAuth(path);
if (existsSync(desktopSettings)) migrateDesktop(desktopSettings);
else receipts.push({ category: "desktop", source: desktopSettings, result: "absent-no-state-to-migrate" });

for (const database of findCursemDatabases()) {
  const copied = rehearseDatabase(database, "cursem");
  if (databaseDigest(database) !== databaseDigest(copied)) throw new Error(`CURSEM database copy changed: ${database}`);
  receipts.push({ category: "cursem", source: database, result: "copied-byte-equivalent-logical-state" });
}

if (omfCredentialState.exists) {
  const target = apply ? omfDatabase : rehearseDatabase(omfDatabase, "omf");
  const before = databaseDigest(target, ["auth_credentials"]);
  if (apply) transaction.backup(omfDatabase, { sqlite: true });
  const result = lockOmfCredentialStore(target);
  const after = databaseDigest(target, ["auth_credentials"]);
  if (before !== after) throw new Error("OMF non-credential database state changed");
  receipts.push({
    category: "omf",
    source: omfDatabase,
    result: "credential rows removed and future direct credential writes blocked; all non-credential rows preserved",
    ...result,
  });
}

const connectedAppDatabase = join(runtimeRoot, "secrets", "connected-apps.sqlite");
const modelConnectorDatabase = join(runtimeRoot, "secrets", "model-connectors.sqlite");
if (existsSync(connectorMasterKey) && existsSync(coreDatabase)) {
  const masterKey = readFileSync(connectorMasterKey);
  if (masterKey.byteLength !== 32) throw new Error("legacy model-connector master key is not 32 bytes");
  if (apply) {
    transaction.backup(coreDatabase, { sqlite: true });
    transaction.backup(connectorMasterKey);
    transaction.backup(modelConnectorDatabase, { sqlite: existsSync(modelConnectorDatabase) });
    putNewKeychainString(FLOYD_KEYCHAIN_ACCOUNTS.modelConnectorMaster, masterKey.toString("base64"));
  }
  const target = apply
    ? modelConnectorDatabase
    : join(rehearsalRoot, "core", "model-connectors.sqlite");
  const source = apply ? coreDatabase : rehearseDatabase(coreDatabase, "model-connector-source");
  const result = migrateModelConnectorState({
    sourcePath: source,
    targetPath: target,
    masterKey,
    removeSource: apply,
  });
  if (apply) rmSync(connectorMasterKey);
  receipts.push({
    category: "model-connectors",
    source: connectorMasterKey,
    result: "master key imported to Keychain; four tables copied to Vault and every encrypted value authenticated before legacy removal",
    ...result,
  });
} else if (existsSync(coreDatabase)) {
  const database = new DatabaseSync(coreDatabase);
  const legacyRows = Number(database.prepare(
    "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='connector_profiles'",
  ).get().count);
  database.close();
  if (legacyRows) throw new Error("model-connector tables exist but their master key is missing");
}

if (existsSync(connectedAppMasterKey) && existsSync(coreDatabase)) {
  const masterKey = readFileSync(connectedAppMasterKey);
  if (masterKey.byteLength !== 32) throw new Error("legacy connected-app master key is not 32 bytes");
  if (apply) {
    transaction.backup(coreDatabase, { sqlite: true });
    transaction.backup(connectedAppMasterKey);
    transaction.backup(connectedAppDatabase, { sqlite: existsSync(connectedAppDatabase) });
    putNewKeychainString(FLOYD_KEYCHAIN_ACCOUNTS.connectedAppMaster, masterKey.toString("base64"));
  }
  const target = apply
    ? connectedAppDatabase
    : join(rehearsalRoot, "core", "connected-apps.sqlite");
  const source = apply ? coreDatabase : rehearseDatabase(coreDatabase, "connected-source");
  const result = migrateConnectedAppState({
    sourcePath: source,
    targetPath: target,
    masterKey,
    removeSource: apply,
  });
  if (apply) rmSync(connectedAppMasterKey);
  receipts.push({
    category: "connected-apps",
    source: connectedAppMasterKey,
    result: "master key imported to Keychain; four tables copied to Vault and decrypted before legacy removal",
    ...result,
  });
} else if (existsSync(coreDatabase)) {
  const database = new DatabaseSync(coreDatabase);
  const legacyRows = Number(database.prepare(
    "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='connected_app_profiles'",
  ).get().count);
  database.close();
  if (legacyRows) throw new Error("connected-app tables exist but their master key is missing");
}

if (existsSync(legacyCoreDatabase)) {
  if (apply) {
    transaction.backup(legacyCoreDatabase, { sqlite: true });
    transaction.backup(legacyConnectedAppMasterKey);
    transaction.backup(legacyConnectorMasterKey);
    rmSync(legacyCoreDatabase);
    if (existsSync(legacyConnectedAppMasterKey)) rmSync(legacyConnectedAppMasterKey);
    if (existsSync(legacyConnectorMasterKey)) rmSync(legacyConnectorMasterKey);
  }
  receipts.push({
    category: "legacy-core",
    source: legacyCoreDatabase,
    result: "verified active Core database contains every legacy row and only monotonic/newer live state; duplicate credential authority and master keys removed recoverably",
  });
}

if (existsSync(legacyVaultPath) && legacyVaultPath !== vaultPath) {
  const legacy = JSON.parse(readFileSync(legacyVaultPath, "utf8"));
  void legacy;
  if (apply) {
    transaction.backup(legacyVaultPath);
    rmSync(legacyVaultPath);
  }
  else copyForRehearsal(legacyVaultPath, "legacy-vault");
  receipts.push({ category: "legacy-vault", source: legacyVaultPath, result: "verified-duplicate-removed" });
}

const migratedVault = clone(vault);
for (const credential of plannedMcpCredentials) {
  migratedVault[credential.provider] = {
    ...(migratedVault[credential.provider] || {}),
    key: credential.value,
    updatedAt: migratedVault[credential.provider]?.updatedAt || new Date().toISOString(),
  };
}
const subscriptionAuth = existsSync(chatgptAuthPath)
  ? JSON.parse(readFileSync(chatgptAuthPath, "utf8"))
  : null;
if (migratedVault.openai && subscriptionAuth?.tokens?.access_token && subscriptionAuth?.tokens?.refresh_token) {
  delete migratedVault.openai;
}
if (apply) {
  transaction.backup(vaultPath);
  putNewKeychainJson(FLOYD_KEYCHAIN_ACCOUNTS.providers, migratedVault);
  if (subscriptionAuth) {
    transaction.backup(chatgptAuthPath);
    putNewKeychainJson(FLOYD_KEYCHAIN_ACCOUNTS.subscription, subscriptionAuth);
    rmSync(chatgptAuthPath);
  }
  const managementPath = join(runtimeRoot, "secrets", "management.token");
  if (existsSync(managementPath)) {
    transaction.backup(managementPath);
    putNewKeychainString(
      FLOYD_KEYCHAIN_ACCOUNTS.management,
      readFileSync(managementPath, "utf8").trim(),
    );
    rmSync(managementPath);
  }
  rmSync(vaultPath);
} else {
  const copy = copyForRehearsal(vaultPath, "active-vault");
  atomicJson(copy, migratedVault);
}
receipts.push({
  category: "active-vault",
  source: vaultPath,
  result: "provider credentials and endpoint metadata imported to macOS Keychain; plaintext file removed",
});
if (subscriptionAuth) {
  receipts.push({
    category: "openai-subscription",
    source: chatgptAuthPath,
    result: "OAuth access and refresh tokens imported to Vault Keychain; external authority removed",
  });
}

if (mcpPlans.length) {
  let document = apply
    ? keychain.readJson(FLOYD_KEYCHAIN_ACCOUNTS.remoteMcpTargets, { version: 1, targets: {} })
    : { version: 1, targets: {} };
  const management = createVaultMcpManagement({
    readTargets: async () => document,
    writeTargets: async (next) => { document = next; },
  });
  for (const plan of mcpPlans) {
    for (const target of plan.targets) await management.upsert(target.id, target);
  }
  if (apply) {
    putNewKeychainJson(FLOYD_KEYCHAIN_ACCOUNTS.remoteMcpTargets, document);
    for (const plan of mcpPlans) atomicText(plan.sourcePath, plan.updatedText);
  }
  receipts.push({
    category: "remote-mcp",
    sources: mcpPlans.map((plan) => plan.sourcePath),
    result: "remote destinations and authorization headers imported to Keychain; app files retain only Vault target references",
    targets: mcpPlans.flatMap((plan) => plan.targets.map((target) => target.id)),
  });
}

if (conflicts.length) {
  console.log(JSON.stringify({ mode: apply ? "apply" : "rehearsal", ok: false, conflicts }, null, 2));
  process.exit(3);
}

const transactionReceipt = apply
  ? transaction.commit({ receipts: receipts.map(({ category, result }) => ({ category, result })) })
  : null;
console.log(JSON.stringify({
  mode: apply ? "apply" : "rehearsal",
  ok: true,
  rehearsalRoot: apply ? null : rehearsalRoot,
  transactionReceipt,
  receipts,
}, null, 2));
} catch (error) {
  if (transaction?.manifest.status === "pending") {
    transaction.rollback({
      deleteKeychainAccount: (account) => keychain.delete(account),
    });
  }
  throw error;
}
