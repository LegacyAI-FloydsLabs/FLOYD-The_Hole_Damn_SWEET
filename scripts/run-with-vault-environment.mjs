#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { applyVaultEnvironment, readVaultAppProfile } from "../lib/vault-routing.mjs";

const [app, profilePath, command, ...args] = process.argv.slice(2);
if (!app || !profilePath || !command) {
  console.error("usage: run-with-vault-environment.mjs <app> <profile> <command> [args...]");
  process.exit(64);
}

let profile;
try {
  profile = readVaultAppProfile(readFileSync(profilePath, "utf8"), app);
} catch (error) {
  console.error(`${app}: Vault application profile unavailable (${error.message}); refusing to launch`);
  process.exit(78);
}

const env = applyVaultEnvironment(
  process.env,
  app,
  profile.token,
  profile.proxy,
  profilePath,
);
const child = spawn(command, args, { env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
child.once("error", (error) => {
  console.error(`${app}: failed to start managed client (${error.message})`);
  process.exit(127);
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
