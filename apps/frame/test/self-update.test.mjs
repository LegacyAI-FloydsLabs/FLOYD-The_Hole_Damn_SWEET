// Tests for self-update.mjs: manifest check, version compare, sha256-gated
// download (fail closed on tamper), dev-checkout no-op.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUpdater, versionGt, installedVersion } from "../server/self-update.mjs";

test("versionGt is numeric-aware", () => {
  assert.equal(versionGt("0.1.10", "0.1.2"), true);
  assert.equal(versionGt("0.2.0", "0.1.99"), true);
  assert.equal(versionGt("0.1.2", "0.1.2"), false);
  assert.equal(versionGt("0.1.1", "0.1.2"), false);
  assert.equal(versionGt("1.0.0", "0.9.9"), true);
});

function tempRoots(version) {
  const repoRoot = mkdtempSync(join(tmpdir(), "flu-repo-"));
  const runtimeRoot = mkdtempSync(join(tmpdir(), "flu-rt-"));
  if (version) writeFileSync(join(repoRoot, "VERSION"), version + "\n");
  return { repoRoot, runtimeRoot };
}

/** One-shot server for a manifest and pkg bytes. */
function serve(routes) {
  const server = http.createServer((req, res) => {
    const hit = routes[req.url];
    if (!hit) { res.writeHead(404); return res.end(); }
    res.writeHead(200);
    res.end(hit);
  });
  return new Promise((resolveP) => {
    server.listen(0, "127.0.0.1", () => resolveP({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test("dev checkout (no VERSION): updates disabled", async () => {
  const { repoRoot, runtimeRoot } = tempRoots(null);
  assert.equal(installedVersion(repoRoot), null);
  const u = createUpdater({ repoRoot, runtimeRoot, manifestUrl: "http://127.0.0.1:1/x" });
  const s = await u.check();
  assert.equal(s.available, null);
  assert.match(s.error, /dev checkout/);
  rmSync(repoRoot, { recursive: true, force: true }); rmSync(runtimeRoot, { recursive: true, force: true });
});

test("newer manifest detected; same-version manifest ignored", async () => {
  const pkg = Buffer.from("pkg-bytes-v2");
  const sha = createHash("sha256").update(pkg).digest("hex");
  const { server, base } = await serve({
    "/manifest.json": JSON.stringify({ version: "0.2.0", pkg_url: "http://unused/", sha256: sha }),
  });
  const { repoRoot, runtimeRoot } = tempRoots("0.1.0");
  const u = createUpdater({ repoRoot, runtimeRoot, manifestUrl: `${base}/manifest.json` });
  const s = await u.check();
  assert.equal(s.available.version, "0.2.0");

  const { repoRoot: r2, runtimeRoot: rt2 } = tempRoots("0.2.0");
  const u2 = createUpdater({ repoRoot: r2, runtimeRoot: rt2, manifestUrl: `${base}/manifest.json` });
  assert.equal((await u2.check()).available, null);
  server.closeAllConnections?.(); server.close();
  for (const d of [repoRoot, runtimeRoot, r2, rt2]) rmSync(d, { recursive: true, force: true });
});

test("download verifies sha256 and writes pkg; tampered bytes rejected", async () => {
  const good = Buffer.from("good-pkg-payload");
  const sha = createHash("sha256").update(good).digest("hex");
  const { server, base } = await serve({
    "/manifest.json": JSON.stringify({ version: "0.9.0", pkg_url: "http://placeholder.invalid/x.pkg", sha256: sha }),
    "/good.pkg": good,
    "/evil.pkg": Buffer.from("tampered-payload"),
  });

  // good: hash matches -> file written
  const { repoRoot, runtimeRoot } = tempRoots("0.1.0");
  const u = createUpdater({ repoRoot, runtimeRoot, manifestUrl: `${base}/manifest.json` });
  await u.check();
  u.state.available.pkg_url = `${base}/good.pkg`;
  const dest = await u.download();
  assert.ok(existsSync(dest));
  assert.equal(u.state.downloaded, dest);

  // evil: hash mismatch -> throws, nothing left on disk
  const { repoRoot: r2, runtimeRoot: rt2 } = tempRoots("0.1.0");
  const u2 = createUpdater({ repoRoot: r2, runtimeRoot: rt2, manifestUrl: `${base}/manifest.json` });
  await u2.check();
  u2.state.available.pkg_url = `${base}/evil.pkg`;
  await assert.rejects(() => u2.download(), /sha256 mismatch/);
  assert.equal(u2.state.downloaded, null);
  assert.equal(existsSync(join(rt2, "FLOYD-0.9.0.pkg")), false);

  server.closeAllConnections?.(); server.close();
  for (const d of [repoRoot, runtimeRoot, r2, rt2]) rmSync(d, { recursive: true, force: true });
});

test("malformed manifest fails closed", async () => {
  const { server, base } = await serve({
    "/bad1.json": JSON.stringify({ version: "9.9.9" }),                       // no url/sha
    "/bad2.json": JSON.stringify({ version: "9.9.9", pkg_url: "x", sha256: "nothex" }),
  });
  const { repoRoot, runtimeRoot } = tempRoots("0.1.0");
  for (const p of ["/bad1.json", "/bad2.json"]) {
    const u = createUpdater({ repoRoot, runtimeRoot, manifestUrl: `${base}${p}` });
    const s = await u.check();
    assert.equal(s.available, null);
    assert.match(s.error, /manifest/);
  }
  server.closeAllConnections?.(); server.close();
  rmSync(repoRoot, { recursive: true, force: true }); rmSync(runtimeRoot, { recursive: true, force: true });
});
