#!/usr/bin/env node
// Ensure workspace deps exist before typecheck. Clean-room CI clones have no
// node_modules; a normal dev checkout already does (no-op, <50ms).
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (!existsSync(join(root, "node_modules", "@floyd", "sdk"))) {
  console.error("[ensure-deps] node_modules incomplete; running npm install…");
  execSync("npm install --no-audit --no-fund", { cwd: root, stdio: "inherit" });
}
