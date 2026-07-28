#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLOYD_KEYCHAIN_ACCOUNTS,
  MacOSKeychainVault,
} from "../apps/frame/server/keychain-vault.mjs";
import { createVaultProxy } from "../apps/frame/server/vault-proxy.mjs";

const runtimeRoot = process.env.FLOYD_RUNTIME_ROOT || "/Volumes/Storage/FLOYD_RUNTIME";
const binary = join(runtimeRoot, "engines", "opencode", "bin", "opencode");
const work = mkdtempSync(join(tmpdir(), "floyd-opencode-vault-live-"));
const isolatedSecrets = join(work, "vault");
const configPath = join(work, "opencode.json");
const marker = "FLOYD_VAULT_LIVE_OK";

const keychain = new MacOSKeychainVault();
const providers = keychain.readJson(FLOYD_KEYCHAIN_ACCOUNTS.providers);
if (!providers.zai?.key) throw new Error("Vault has no configured Z.ai credential");
const subscriptionStore = {
  read: () => keychain.readJson(FLOYD_KEYCHAIN_ACCOUNTS.subscription, {}),
  write: (value) => keychain.writeJson(FLOYD_KEYCHAIN_ACCOUNTS.subscription, value),
};

const proxy = createVaultProxy({
  secretsDir: isolatedSecrets,
  realKey: (provider) => providers[provider]?.key || null,
  subscriptionStore,
  port: 0,
});
const address = await proxy.listen();
const proxyUrl = `http://127.0.0.1:${address.port}`;
const token = proxy.store.issue("opencode-live-proof");

mkdirSync(join(work, "xdg-config"), { recursive: true });
writeFileSync(configPath, JSON.stringify({
  "$schema": "https://opencode.ai/config.json",
  provider: {
    "zai-coding-plan": {
      options: {
        apiKey: token,
        baseURL: `${proxyUrl}/p/zai/api/coding/paas/v4`,
      },
    },
  },
  model: "zai-coding-plan/glm-4.7",
  share: "disabled",
  autoupdate: false,
  disabled_providers: ["opencode"],
  permission: { edit: "deny", bash: "deny", webfetch: "deny" },
}, null, 2), { mode: 0o600 });

function run() {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(binary, [
      "run",
      "--pure",
      "--format", "json",
      "--model", "zai-coding-plan/glm-4.7",
      `Reply with exactly: ${marker}`,
    ], {
      cwd: work,
      env: {
        HOME: work,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        XDG_DATA_HOME: join(work, "xdg-data"),
        XDG_CONFIG_HOME: join(work, "xdg-config"),
        XDG_CACHE_HOME: join(work, "xdg-cache"),
        XDG_STATE_HOME: join(work, "xdg-state"),
        OPENCODE_CONFIG: configPath,
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun(stdout);
      else rejectRun(new Error(`OpenCode live proof exited ${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

try {
  const output = await run();
  const record = proxy.store.list().find((entry) => entry.app === "opencode-live-proof");
  if (!output.includes(marker)) throw new Error("OpenCode did not return the requested GLM marker");
  if (!record?.routes?.zai?.success_count) throw new Error("Vault did not record a successful Z.ai route");
  console.log("OPENCODE_VAULT_LIVE PASS version=1.17.18 route=zai credential=fv response=real");
} finally {
  await proxy.close();
}
