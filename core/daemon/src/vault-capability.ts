import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LOOPBACK, RUNTIME_ROOT } from "./config.ts";

export type CoreVaultCapability = Readonly<{
  token: string;
  proxy: string;
  source: "floyd-vault:core";
}>;

/** Core trusts only the owner-only profile written by Frame/Vault.
 * Launch environment values are deliberately ignored so inherited or stale
 * credentials cannot override Vault after startup. */
export function readCoreVaultCapability(): CoreVaultCapability {
  const profilePath = join(RUNTIME_ROOT, "secrets", "proxy-app-profiles", "core.json");
  let metadata;
  let profile: Record<string, unknown>;
  try {
    metadata = lstatSync(profilePath);
    profile = JSON.parse(readFileSync(profilePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Floyd Core Vault application profile is unavailable: ${profilePath}`, { cause: error });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || metadata.mode & 0o077
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new Error("Floyd Core Vault application profile must be an owner-only regular file");
  }
  const token = String(profile.proxyToken || profile.token || "").trim();
  const proxy = String(profile.proxyUrl || profile.proxy || "").trim().replace(/\/+$/, "");
  if (profile.app !== "core" || !/^fv_core_[0-9a-f]{32,}$/.test(token)) {
    throw new Error("Floyd Core requires its persistent fv_ Vault capability");
  }
  let parsed: URL;
  try { parsed = new URL(proxy); } catch { throw new Error("Floyd Core Vault address is invalid"); }
  if (parsed.protocol !== "http:" || parsed.hostname !== LOOPBACK || parsed.username || parsed.password
    || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error("Floyd Core Vault address must be the HTTP loopback listener");
  }
  return { token, proxy, source: "floyd-vault:core" };
}
