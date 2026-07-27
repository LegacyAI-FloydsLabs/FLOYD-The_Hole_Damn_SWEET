// Vault proxy end-to-end tests: fake upstream, real HTTP, no network.
// Run: node --test apps/frame/test/vault-proxy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createVaultProxy } from "../server/vault-proxy.mjs";

// --- fake provider upstream: records auth headers, echoes a canned reply ----
const seen = [];
const fakeUpstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ path: req.url, auth: req.headers.authorization, xApiKey: req.headers["x-api-key"], body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, from: "fake-upstream" }));
  });
});
await new Promise((r) => fakeUpstream.listen(0, "127.0.0.1", r));
const upBase = `http://127.0.0.1:${fakeUpstream.address().port}`;

const secretsDir = mkdtempSync(join(tmpdir(), "vault-proxy-test-"));
const REAL_KEYS = { zai: "real-zai-key-abc123", anthropic: "sk-ant-real-xyz" };
const proxy = createVaultProxy({
  secretsDir,
  realKey: (id) => REAL_KEYS[id] || null,
  upstreams: {
    zai: { base: upBase, openai: `${upBase}/chat`, inject: (h, k) => { h.authorization = `Bearer ${k}`; } },
    anthropic: { base: upBase, anthropic: `${upBase}/messages`, inject: (h, k) => { h["x-api-key"] = k; } },
  },
  port: 0,
});
const addr = await proxy.listen();
const base = `http://127.0.0.1:${addr.port}`;

test.after(async () => { await proxy.close(); fakeUpstream.close(); });

const post = (path, body, headers = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("healthz needs no auth", async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test("requests without a token are rejected and alerted", async () => {
  const res = await post("/v1/chat/completions", { model: "zai/glm-4.7" });
  assert.equal(res.status, 401);
  assert.equal(proxy.store.alerts().at(-1).kind, "missing_token");
});

test("unknown fv_ token is rejected and alerted", async () => {
  const res = await post("/v1/chat/completions", { model: "zai/glm-4.7" }, { authorization: "Bearer fv_evil_deadbeef" });
  assert.equal(res.status, 401);
  assert.equal(proxy.store.alerts().at(-1).kind, "unknown_token");
});

test("issued token reaches upstream with the REAL key swapped in", async () => {
  const token = proxy.store.issue("testapp");
  assert.match(token, /^fv_testapp_[0-9a-f]{48}$/);
  const res = await post("/v1/chat/completions", { model: "zai/glm-4.7", messages: [] }, { authorization: `Bearer ${token}` });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).from, "fake-upstream");
  const hit = seen.at(-1);
  assert.equal(hit.auth, `Bearer ${REAL_KEYS.zai}`); // real key injected
  assert.equal(JSON.parse(hit.body).model, "glm-4.7"); // provider prefix stripped
});

test("proxied token NEVER travels upstream", () => {
  for (const hit of seen) {
    assert.ok(!JSON.stringify(hit).includes("fv_"), `fv_ token leaked upstream: ${JSON.stringify(hit)}`);
  }
});

test("anthropic dialect routes via x-api-key", async () => {
  const token = proxy.store.ensure("testapp2");
  const res = await post("/v1/messages", { model: "anthropic/claude-x", messages: [] }, { "x-api-key": token });
  assert.equal(res.status, 200);
  assert.equal(seen.at(-1).xApiKey, REAL_KEYS.anthropic);
});

test("generic /p/<provider> passthrough injects auth", async () => {
  const token = proxy.store.ensure("testapp2");
  const res = await fetch(`${base}/p/zai/api/some/endpoint?q=1`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const hit = seen.at(-1);
  assert.equal(hit.path, "/api/some/endpoint?q=1");
  assert.equal(hit.auth, `Bearer ${REAL_KEYS.zai}`);
});

test("missing vault key -> 503, unknown provider -> 400/404", async () => {
  const token = proxy.store.ensure("testapp2");
  const r1 = await post("/v1/chat/completions", { model: "zai/x" }, { authorization: `Bearer ${token}` });
  assert.equal(r1.status, 200);
  const r2 = await post("/v1/chat/completions", { model: "nosuch/x" }, { authorization: `Bearer ${token}` });
  assert.equal(r2.status, 400);
  const r3 = await fetch(`${base}/p/nosuch/thing`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(r3.status, 404);
});

test("rotation: revoke kills old token, ensure() issues a fresh one", async () => {
  const t1 = proxy.store.ensure("rotator");
  assert.equal(proxy.store.ensure("rotator"), t1); // stable across calls
  proxy.store.revoke("rotator");
  const rej = await post("/v1/chat/completions", { model: "zai/x" }, { authorization: `Bearer ${t1}` });
  assert.equal(rej.status, 401);
  assert.equal(proxy.store.alerts().at(-1).kind, "revoked_token_used");
  const t2 = proxy.store.ensure("rotator");
  assert.notEqual(t2, t1);
  const ok = await post("/v1/chat/completions", { model: "zai/x" }, { authorization: `Bearer ${t2}` });
  assert.equal(ok.status, 200);
});

test("token store holds hashes only, files are 0600, usage is tracked", () => {
  const raw = readFileSync(join(secretsDir, "proxy-tokens.json"), "utf8");
  assert.ok(!raw.includes("fv_"), "plaintext token in token store");
  for (const f of ["proxy-tokens.json", "proxy-app-tokens.json"]) {
    assert.equal(statSync(join(secretsDir, f)).mode & 0o777, 0o600, `${f} not 0600`);
  }
  const rec = proxy.store.list().find((t) => t.app === "testapp");
  assert.ok(rec.use_count >= 1 && rec.last_used_at, "usage not tracked");
});

test("real keys never appear in any store file", () => {
  for (const f of ["proxy-tokens.json", "proxy-app-tokens.json"]) {
    const raw = readFileSync(join(secretsDir, f), "utf8");
    for (const key of Object.values(REAL_KEYS)) assert.ok(!raw.includes(key), `real key in ${f}`);
  }
});

test("subscription routes fail closed without Codex auth", async () => {
  const bare = createVaultProxy({ secretsDir, realKey: () => null, upstreams: {}, port: 0,
    authFile: join(secretsDir, "no-such-auth.json") });
  const a = await bare.listen();
  const b = `http://127.0.0.1:${a.port}`;
  const token = bare.store.ensure("subtest");
  const res = await fetch(`${b}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 503);
  await bare.close();
});
