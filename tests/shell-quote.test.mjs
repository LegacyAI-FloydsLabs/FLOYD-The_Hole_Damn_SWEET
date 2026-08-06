import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { shellQuote } from "../lib/shell-quote.mjs";

// The installed app lives under "/Applications/FLOYD Desktop Suite.app/...".
// Any unquoted interpolation of that path into a shell command word-splits
// and dies 127 ("no such file or directory: /Applications/FLOYD") — this was
// the OMF/FLOYD-CLI wrapper bug. These tests pin the quoting contract for
// every shell-command construction that lives outside the launcher surface
// (the launcher keeps its own tested CJS twin in src/shell-quote.js).

test("shellQuote wraps tokens containing spaces", () => {
  assert.equal(shellQuote("/Applications/FLOYD Desktop Suite.app/x"), "'/Applications/FLOYD Desktop Suite.app/x'");
});

test("shellQuote neutralizes embedded single quotes and metacharacters", () => {
  assert.equal(shellQuote("it's $(rm -rf ~)"), `'it'"'"'s $(rm -rf ~)'`);
  assert.equal(shellQuote("a;b|&><`id`"), `'a;b|&><\`id\`'`);
});

test("a quoted wrapper exec line runs the real file, not the first word", () => {
  // End-to-end through zsh: a script at a space-bearing path must execute.
  const dir = execFileSync("mktemp", ["-d", "/tmp/floyd quote test.XXXXXX"], { encoding: "utf8" }).trim();
  const script = `${dir}/echo ok.sh`;
  execFileSync("sh", ["-c", `printf '#!/bin/zsh\\necho WRAPPER-RAN\\n' > ${shellQuote(script)} && chmod 755 ${shellQuote(script)}`]);
  const out = execFileSync("/bin/zsh", ["-c", `exec ${shellQuote(script)}`], { encoding: "utf8" });
  assert.match(out, /WRAPPER-RAN/);
  // Counter-proof: the unquoted form must fail the way the bug did.
  assert.throws(() => execFileSync("/bin/zsh", ["-c", `exec ${script}`], { encoding: "utf8", stdio: "pipe" }));
});
