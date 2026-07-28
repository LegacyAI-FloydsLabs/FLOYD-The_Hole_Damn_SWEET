#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  applyVaultEnvironment,
  readVaultAppProfile,
} from "../lib/vault-routing.mjs";
import {
  mergeUpdatedFloydProviderMetadata,
  readFloydConfig,
  writeUpdatedFloydConfig,
} from "./lib/floyd-provider-update.mjs";

const [app, profilePath, binary, managedDir, ...args] = process.argv.slice(2);
if (!["ff", "launcher"].includes(app) || !profilePath || !binary || !managedDir
    || !args.includes("update-providers")) {
  console.error("usage: update-floyd-providers-with-vault.mjs <ff|launcher> <profile> <binary> <managed-dir> [... update-providers ...]");
  process.exit(64);
}

let profile;
try {
  profile = readVaultAppProfile(readFileSync(profilePath, "utf8"), app);
} catch (error) {
  console.error(`${app}: Vault application profile unavailable (${error.message}); refusing provider update`);
  process.exit(78);
}

for (const arg of args) {
  if (!/^https?:\/\//i.test(arg)) continue;
  const source = new URL(arg);
  const credentialParameter = [...source.searchParams.keys()]
    .find((name) => /(?:^|[_-])(?:api[_-]?key|token|secret|credential|password|signature|authorization)(?:[_-]|$)/i.test(name));
  const credentialFragment = /(?:api[_-]?key|token|secret|credential|password|signature|authorization)=/i.test(source.hash);
  if (source.username || source.password || credentialParameter || credentialFragment) {
    console.error(`${app}: provider update URL cannot contain credentials`);
    process.exit(64);
  }
}

mkdirSync(managedDir, { recursive: true, mode: 0o700 });
const stageRoot = mkdtempSync(join(tmpdir(), "floyd-provider-update-"));
const stageHome = join(stageRoot, "home");
const stageData = join(stageRoot, "data");
mkdirSync(stageHome, { recursive: true, mode: 0o700 });
mkdirSync(stageData, { recursive: true, mode: 0o700 });

try {
  const env = applyVaultEnvironment(process.env, app, profile.token, profile.proxy, profilePath);
  env.HOME = stageHome;
  env.FLOYD_GLOBAL_DATA = managedDir;
  const result = spawnSync(binary, ["-D", stageData, ...args], {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(`provider update terminated by ${result.signal}`);
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  } else {
    const catalogPath = join(stageHome, ".local", "share", "floyd", "providers.json");
    if (!existsSync(catalogPath)) throw new Error("provider updater completed without producing providers.json");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    const current = readFloydConfig(managedDir);
    const updated = mergeUpdatedFloydProviderMetadata(
      current,
      catalog,
      profile.token,
      profile.proxy,
    );
    writeUpdatedFloydConfig(managedDir, updated);
    console.log(`${app}: provider model metadata updated; credentials and destinations remain managed by Floyd Vault.`);
  }
} catch (error) {
  console.error(`${app}: provider update rejected (${error.message})`);
  process.exitCode = 1;
} finally {
  rmSync(stageRoot, { recursive: true, force: true });
}
