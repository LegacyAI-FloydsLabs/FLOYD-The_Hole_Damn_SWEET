#!/usr/bin/env node
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  buildFloydProviderConfig,
  buildOmpProviderConfig,
  assertVaultOnlyClientConfiguration,
  assertVaultOnlyClientText,
  readVaultAppProfile,
} from "../lib/vault-routing.mjs";

const [client, profilePath, sourceDir, managedDir] = process.argv.slice(2);
if (!["ff", "omf"].includes(client) || !profilePath || !sourceDir || !managedDir) {
  console.error("usage: materialize-vault-client-config.mjs <ff|omf> <profile> <source-dir> <managed-dir>");
  process.exit(64);
}

let profile;
try {
  profile = readVaultAppProfile(readFileSync(profilePath, "utf8"), client);
} catch (error) {
  console.error(`${client}: Vault unavailable (${error.message}); refusing to launch`);
  process.exit(78);
}

mkdirSync(managedDir, { recursive: true, mode: 0o700 });

if (client === "ff") {
  let config = {};
  try { config = JSON.parse(readFileSync(join(sourceDir, "floyd.json"), "utf8")); } catch { /* first launch */ }
  config.providers = buildFloydProviderConfig(profile.token, profile.proxy);
  config.options = {
    ...(config.options && typeof config.options === "object" ? config.options : {}),
    disable_default_providers: true,
    disable_provider_auto_update: true,
  };
  assertVaultOnlyClientConfiguration(config, "FF managed configuration");
  const output = join(managedDir, "floyd.json");
  writeFileSync(output, JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(output, 0o600);
} else {
  preserveOmpAgentState(sourceDir, managedDir, profile);
  assertVaultOnlyDirectory(managedDir);
  const output = join(managedDir, "models.yml");
  // JSON is valid YAML and avoids a runtime parser dependency.
  writeFileSync(output, JSON.stringify({
    providers: buildOmpProviderConfig(profile.token, profile.proxy),
  }, null, 2), { mode: 0o600 });
  chmodSync(output, 0o600);
  const policy = join(managedDir, "vault-policy.yml");
  writeFileSync(policy, JSON.stringify({
    "web_search.enabled": true,
    "providers.webSearch": "tavily",
    "github.enabled": true,
    "mcp.enableProjectConfig": true,
    "tools.discoveryMode": "auto",
  }, null, 2), { mode: 0o600 });
  chmodSync(policy, 0o600);
}

function assertVaultOnlyDirectory(root) {
  const walk = (path) => {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`OMF managed state contains an unverified symbolic link: ${path}`);
    }
    if (metadata.isDirectory()) {
      for (const child of readdirSync(path)) walk(join(path, child));
      return;
    }
    if (!metadata.isFile()) return;
    const raw = readFileSync(path);
    if (raw.includes(0)) return;
    assertVaultOnlyClientText(raw.toString("utf8"), `OMF managed file ${path}`);
  };
  walk(root);
}

function preserveOmpAgentState(sourceDir, managedDir, profile) {
  if (!existsSync(sourceDir) || resolve(sourceDir) === resolve(managedDir)) return;
  const excludedRoots = new Set([
    ".env",
    ".git",
    "agent.db",
    "auth-broker.token",
    "auth-gateway.token",
    "auth.json",
    "cache",
    "credentials.json",
    "logs",
    "models.yml",
    "secrets",
  ]);
  cpSync(sourceDir, managedDir, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    filter(source) {
      const rel = relative(sourceDir, source);
      if (!rel) return true;
      const root = rel.split(/[\\/]/, 1)[0];
      return !excludedRoots.has(root) && !/^agent\\.db(?:-|$)/.test(root);
    },
  });

  const configPath = join(managedDir, "config.yml");
  if (existsSync(configPath)) {
    const source = readFileSync(configPath, "utf8");
    const sanitized = source
      .split(/\r?\n/)
      .filter((line) => {
        const key = line.match(/^\s*([^#\s][^:]*?)\s*:/)?.[1];
        return !key || !/(?:api[-_.]?key|auth.*token|bearer|cookie|password|secret)/i.test(key);
      })
      .join("\n");
    writeFileSync(configPath, sanitized, { mode: 0o600 });
    chmodSync(configPath, 0o600);
  }

  for (const name of ["mcp.json", ".mcp.json"]) {
    const path = join(managedDir, name);
    if (!existsSync(path)) continue;
    const document = JSON.parse(readFileSync(path, "utf8"));
    const servers = document?.mcpServers;
    if (!servers || typeof servers !== "object") continue;
    for (const [id, raw] of Object.entries(servers)) {
      if (!raw || typeof raw !== "object") continue;
      if (raw.vault?.target) {
        servers[id] = {
          ...raw,
          url: `${profile.proxy}/mcp/${encodeURIComponent(raw.vault.target)}`,
          headers: { authorization: `Bearer ${profile.token}` },
        };
        delete servers[id].vault;
        continue;
      }
      if (typeof raw.url === "string") {
        const url = new URL(raw.url);
        const loopback = url.protocol === "http:"
          && ["127.0.0.1", "localhost", "::1"].includes(url.hostname.replace(/^\[|\]$/g, ""));
        const secretHeaders = Object.keys(raw.headers || {}).some((key) => /authorization|api[-_]?key|token|secret|cookie/i.test(key));
        if (!loopback || secretHeaders) {
          throw new Error(`OMF MCP ${id} must be imported into Floyd Vault before launch`);
        }
      }
      for (const key of Object.keys(raw.env || {})) {
        if (/api[-_]?key|token|secret|cookie|password/i.test(key)) {
          throw new Error(`OMF stdio MCP ${id} env.${key} must be imported into Floyd Vault before launch`);
        }
      }
    }
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
}
