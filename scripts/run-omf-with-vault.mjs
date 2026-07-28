#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  applyVaultEnvironment,
  readVaultAppProfile,
} from "../lib/vault-routing.mjs";
import { prepareOmpInvocation } from "../lib/omf-vault-args.mjs";

const [profilePath, command, policy, ...rawArgs] = process.argv.slice(2);
if (!profilePath || !command || !policy) {
  console.error("usage: run-omf-with-vault.mjs <profile> <command> <policy> [args...]");
  process.exit(64);
}

let profile;
try {
  profile = readVaultAppProfile(readFileSync(profilePath, "utf8"), "omf");
} catch (error) {
  console.error(`omf: Vault unavailable (${error.message}); refusing to launch`);
  process.exit(78);
}

const invocation = prepareOmpInvocation(rawArgs, profile.token);
if (invocation.kind === "vault-handoff") {
  const handoff = resolve(dirname(fileURLToPath(import.meta.url)), "vault-provider-handoff.mjs");
  const opener = spawn(process.execPath, [handoff, "omf", "login"], {
    stdio: "inherit",
    shell: false,
  });
  opener.once("error", (error) => {
    console.error(`omf: failed to open Floyd Vault (${error.message})`);
    process.exit(70);
  });
  opener.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
} else {
  const args = invocation.args;
  args.push("--config", policy);
  const env = applyVaultEnvironment(process.env, "omf", profile.token, profile.proxy, profilePath);
  const child = spawn(command, args, {
    stdio: "inherit",
    env,
    shell: false,
  });
  child.once("error", (error) => {
    console.error(`omf: failed to launch (${error.message})`);
    process.exit(70);
  });
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}
