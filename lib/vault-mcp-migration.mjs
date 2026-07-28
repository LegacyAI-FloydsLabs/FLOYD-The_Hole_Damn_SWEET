import { createHash } from "node:crypto";
import { PROVIDER_CREDENTIAL_ENV } from "./vault-routing.mjs";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Build a lossless migration plan for one CURSEM MCP file.
 *
 * Remote destinations and headers move into the Vault target record. The
 * application file retains its server id and unrelated metadata but contains
 * only a nonsecret `{ vault: { target } }` reference.
 */
export function planVaultMcpMigration({ sourcePath, text, apps = ["cursem"] }) {
  const document = JSON.parse(text);
  const servers = document?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return { sourcePath, changed: false, originalText: text, updatedText: text, targets: [] };
  }

  const next = structuredClone(document);
  const targets = [];
  const providerCredentials = [];
  for (const [serverId, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== "object") continue;
    if (typeof raw.url === "string") {
      const parsed = new URL(raw.url);
      const isLoopback = parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname.replace(/^\[|\]$/g, ""));
      const hasHeaders = raw.headers && typeof raw.headers === "object" && Object.keys(raw.headers).length > 0;
      if (!isLoopback || hasHeaders) {
        if (parsed.protocol !== "https:" && !isLoopback) {
          throw new Error(`MCP server ${serverId} must use HTTPS or loopback HTTP before Vault import`);
        }

        const targetId = stableTargetId(sourcePath, serverId);
        const { url: _url, headers: _headers, vault: _vault, ...metadata } = raw;
        next.mcpServers[serverId] = { ...metadata, vault: { target: targetId } };
        targets.push({
          id: targetId,
          url: parsed.toString(),
          headers: Object.fromEntries(Object.entries(raw.headers || {}).map(([name, value]) => [name, String(value)])),
          apps: [...new Set(apps.map(String))],
          source: { path: sourcePath, serverId },
        });
      }
    }
    if (typeof raw.command === "string" && raw.env && typeof raw.env === "object") {
      const safeEnv = {};
      const vaultEnv = { ...(raw.vaultEnv && typeof raw.vaultEnv === "object" ? raw.vaultEnv : {}) };
      for (const [name, value] of Object.entries(raw.env)) {
        const provider = providerForEnvironmentName(name);
        if (provider && isCredentialEnvironmentName(name)) {
          providerCredentials.push({
            provider,
            value: String(value),
            source: { path: sourcePath, serverId, name },
          });
          vaultEnv[name] = provider;
        } else if (provider && /(?:_BASE_URL|_ENDPOINT|_API_URL)$/.test(name.toUpperCase())) {
          vaultEnv[name] = provider;
        } else {
          safeEnv[name] = value;
        }
      }
      next.mcpServers[serverId] = { ...next.mcpServers[serverId], env: safeEnv, vaultEnv };
    }
  }

  return {
    sourcePath,
    changed: targets.length > 0 || providerCredentials.length > 0,
    originalText: text,
    updatedText: targets.length > 0 || providerCredentials.length > 0 ? `${JSON.stringify(next, null, 2)}\n` : text,
    targets,
    providerCredentials,
  };
}

/** Require one unambiguous credential per provider across every discovered
 * stdio MCP config before any file or Keychain mutation. */
export function reconcileVaultMcpProviderCredentials(plans, existingVault = {}) {
  const reconciled = new Map();
  for (const plan of plans) {
    for (const credential of plan.providerCredentials || []) {
      const existing = existingVault[credential.provider]?.key;
      const expected = existing || reconciled.get(credential.provider)?.value;
      if (expected && expected !== credential.value) {
        throw new Error(`stdio MCP credential conflict for provider ${credential.provider}`);
      }
      if (!reconciled.has(credential.provider)) reconciled.set(credential.provider, credential);
    }
  }
  return [...reconciled.values()];
}

/**
 * Apply target imports before rewriting the app config. Every imported target
 * must return an async rollback function; failures unwind in reverse order.
 * The returned rollback also restores the original application config.
 */
export async function applyVaultMcpMigration({
  plan,
  putTarget,
  putProviderCredential = async () => async () => {},
  writeConfig,
}) {
  if (!plan.changed) return { changed: false, rollback: async () => {} };
  if (typeof putTarget !== "function" || typeof writeConfig !== "function") {
    throw new Error("Vault MCP migration requires target and config writers");
  }
  const targetRollbacks = [];
  try {
    for (const target of plan.targets) {
      const rollback = await putTarget(target);
      if (typeof rollback !== "function") {
        throw new Error(`Vault target import did not provide rollback: ${target.id}`);
      }
      targetRollbacks.push(rollback);
    }
    for (const credential of plan.providerCredentials || []) {
      const rollback = await putProviderCredential(credential);
      if (typeof rollback !== "function") {
        throw new Error(`Vault provider credential import did not provide rollback: ${credential.provider}`);
      }
      targetRollbacks.push(rollback);
    }
    await writeConfig(plan.sourcePath, plan.updatedText);
  } catch (error) {
    await rollbackAll(targetRollbacks);
    throw error;
  }
  return {
    changed: true,
    targets: plan.targets.map(({ id }) => id),
    rollback: async () => {
      await writeConfig(plan.sourcePath, plan.originalText);
      await rollbackAll(targetRollbacks);
    },
  };
}

const ENV_PROVIDER = new Map(
  Object.entries(PROVIDER_CREDENTIAL_ENV)
    .flatMap(([provider, names]) => names.map((name) => [name, provider])),
);
ENV_PROVIDER.set("GITHUB_PAT", "github");

function providerForEnvironmentName(name) {
  const normalized = String(name).toUpperCase();
  if (ENV_PROVIDER.has(normalized)) return ENV_PROVIDER.get(normalized);
  for (const provider of Object.keys(PROVIDER_CREDENTIAL_ENV)) {
    if (normalized.startsWith(`${provider.toUpperCase()}_`)) return provider;
  }
  if (normalized.startsWith("GH_") || normalized.startsWith("GITHUB_")) return "github";
  if (normalized.startsWith("GEMINI_") || normalized.startsWith("GOOGLE_")) return "google";
  if (normalized.startsWith("ZHIPU_") || normalized.startsWith("GLM_")) return "zai";
  return null;
}

function isCredentialEnvironmentName(name) {
  return /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|CREDENTIALS?|PASSWORD|PASS|COOKIE|AUTHORIZATION|PAT)(?:_|$)/.test(
    String(name).toUpperCase(),
  );
}

function stableTargetId(sourcePath, serverId) {
  const digest = createHash("sha256").update(`${sourcePath}\0${serverId}`).digest("hex").slice(0, 12);
  const safeId = serverId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60) || "remote";
  return `cursem-${safeId}-${digest}`;
}

async function rollbackAll(rollbacks) {
  let firstError;
  for (const rollback of [...rollbacks].reverse()) {
    try {
      await rollback();
    } catch (error) {
      firstError ||= error;
    }
  }
  if (firstError) throw firstError;
}
