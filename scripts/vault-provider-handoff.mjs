#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const [client, action] = process.argv.slice(2);
if (!["ff", "launcher", "omf", "frame"].includes(client)
    || !["login", "chatgpt-subscription"].includes(action)) {
  console.error("usage: vault-provider-handoff.mjs <ff|launcher|omf|frame> <login|chatgpt-subscription>");
  process.exit(64);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const shell = resolve(scriptDir, "../apps/frame/native/FloydShell");
const shellArgs = action === "chatgpt-subscription"
  ? ["--vault", "--chatgpt-subscription"]
  : ["--vault"];

console.log(action === "chatgpt-subscription"
  ? `${client}: opening native ChatGPT/Codex subscription management through Floyd Vault`
  : `${client}: opening Floyd Vault provider management in FloydShell --vault`);
if (process.env.FLOYD_VAULT_HANDOFF_NO_OPEN === "1") process.exit(0);

const childEnv = Object.fromEntries(
  ["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_CTYPE"]
    .filter((name) => typeof process.env[name] === "string")
    .map((name) => [name, process.env[name]]),
);
if (/^\d{2,5}$/.test(process.env.FRAME_PORT || "")) childEnv.FRAME_PORT = process.env.FRAME_PORT;

const shellProcess = spawn(shell, shellArgs, {
  detached: true,
  env: childEnv,
  stdio: "ignore",
  shell: false,
});
shellProcess.once("error", (error) => {
  console.error(`${client}: unable to open Floyd Vault (${error.message})`);
  process.exit(70);
});
shellProcess.once("spawn", () => {
  shellProcess.unref();
  process.exit(0);
});
