import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const configUrl = pathToFileURL(resolve("core/daemon/src/config.ts")).href;
const program = `import { REMOTE_PUBLIC_ORIGIN } from ${JSON.stringify(configUrl)}; process.stdout.write(REMOTE_PUBLIC_ORIGIN);`;

function probe(origin: string) {
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: { ...process.env, FLOYD_REMOTE_ORIGIN: origin },
  });
}

test("remote public origin is canonicalized and restricted to a bare HTTPS origin", () => {
  const canonical = probe("https://floyd.test:8443/");
  assert.equal(canonical.status, 0, canonical.stderr);
  assert.equal(canonical.stdout, "https://floyd.test:8443");

  for (const invalid of [
    "http://floyd.test:8443",
    "https://user:pass@floyd.test:8443",
    "https://floyd.test:8443/path",
    "not-a-url",
  ]) {
    const result = probe(invalid);
    assert.notEqual(result.status, 0, invalid);
    assert.match(result.stderr, /FLOYD_REMOTE_ORIGIN/);
  }
});
