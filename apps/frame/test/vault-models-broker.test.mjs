// Live model catalog broker tests: fake upstream, real HTTP, no network.
// Run: node --test apps/frame/test/vault-models-broker.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createVaultProxy } from "../server/vault-proxy.mjs";

// --- fake provider upstream: answers the three list shapes by path ----------
const hits = new Map();
const fakeUpstream = http.createServer((req, res) => {
  hits.set(req.url, (hits.get(req.url) || 0) + 1);
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url === "/api/coding/paas/v4/models") {
    return res.end(JSON.stringify({ object: "list", data: [
      { id: "glm-5.2", object: "model", owned_by: "z-ai" },
      { id: "glm-4.7", object: "model", owned_by: "z-ai" },
    ] }));
  }
  if (req.url === "/v1beta/models") {
    return res.end(JSON.stringify({ models: [
      { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
      { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
    ] }));
  }
  if (req.url === "/v1/models") {
    return res.end(JSON.stringify({ data: [
      { type: "model", id: "claude-opus-5", display_name: "Claude Opus 5" },
      { type: "model", id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
    ] }));
  }
  res.end(JSON.stringify({ object: "list", data: [] }));
});
await new Promise((r) => fakeUpstream.listen(0, "127.0.0.1", r));
const upBase = `http://127.0.0.1:${fakeUpstream.address().port}`;

const REAL_KEYS = { zai: "real-zai-key", anthropic: "sk-ant-real", google: "AIza-real" };
const inject = {
  bearer: (h, k) => { h.authorization = `Bearer ${k}`; },
  anthropic: (h, k) => { h["x-api-key"] = k; },
  google: (h, k) => { h["x-goog-api-key"] = k; },
};
const proxy = createVaultProxy({
  secretsDir: mkdtempSync(join(tmpdir(), "vault-models-test-")),
  realKey: (id) => REAL_KEYS[id] || null,
  upstreams: {
    zai: { base: upBase, inject: inject.bearer },
    anthropic: { base: upBase, inject: inject.anthropic },
    google: { base: upBase, inject: inject.google },
  },
  port: 0,
});
const addr = await proxy.listen();
const base = `http://127.0.0.1:${addr.port}`;
const token = proxy.store.issue("desktop");
const authed = { authorization: `Bearer ${token}` };

test.after(async () => { await proxy.close(); fakeUpstream.close(); });

test("requires a valid proxied token", async () => {
  const res = await fetch(`${base}/models/zai`);
  assert.equal(res.status, 401);
});

test("openai-dialect list normalizes to {id, name}", async () => {
  const res = await fetch(`${base}/models/zai`, { headers: authed });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.provider, "zai");
  assert.equal(body.source, "live");
  assert.deepEqual(body.models.map((m) => m.id), ["glm-5.2", "glm-4.7"]);
});

test("google shape strips the models/ prefix and uses displayName", async () => {
  const res = await fetch(`${base}/models/google`, { headers: authed });
  const body = await res.json();
  assert.deepEqual(body.models.map((m) => m.id), ["gemini-2.5-pro", "gemini-2.5-flash"]);
  assert.equal(body.models[0].name, "Gemini 2.5 Pro");
});

test("anthropic shape uses display_name", async () => {
  const res = await fetch(`${base}/models/anthropic`, { headers: authed });
  const body = await res.json();
  assert.deepEqual(body.models.map((m) => m.id), ["claude-opus-5", "claude-sonnet-4-6"]);
  assert.equal(body.models[0].name, "Claude Opus 5");
});

test("repeat calls serve the cache, not the upstream", async () => {
  const before = hits.get("/api/coding/paas/v4/models") || 0;
  const res = await fetch(`${base}/models/zai`, { headers: authed });
  assert.equal((await res.json()).source, "cache");
  assert.equal(hits.get("/api/coding/paas/v4/models"), before);
});

test("unknown provider is a 404", async () => {
  const res = await fetch(`${base}/models/nope`, { headers: authed });
  assert.equal(res.status, 404);
});

test("provider without a model catalog is a 404", async () => {
  const res = await fetch(`${base}/models/github`, { headers: authed });
  assert.equal(res.status, 404);
});

test("keyed provider missing from vault is a 503", async () => {
  const res = await fetch(`${base}/models/deepseek`, { headers: authed });
  assert.equal(res.status, 503);
});

test("openai subscription serves the curated list without an upstream", async () => {
  const res = await fetch(`${base}/models/openai`, { headers: authed });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, "fallback");
  // Never assert literal model names — catalogs churn daily. Assert the mechanism.
  assert.equal(Array.isArray(body.models), true);
  assert.ok(body.models.length > 0, "curated list must never be empty");
  for (const model of body.models) {
    assert.equal(typeof model.id, "string");
    assert.ok(model.id.length > 0);
    assert.equal(typeof model.name, "string");
  }
});

test("aggregate /models covers keyed providers only", async () => {
  const res = await fetch(`${base}/models`, { headers: authed });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body.providers).sort(), ["anthropic", "google", "zai"]);
  assert.equal(body.providers.zai.source === "live" || body.providers.zai.source === "cache", true);
});

test("upstream failure falls back to the static catalog list", async () => {
  const broken = createVaultProxy({
    secretsDir: mkdtempSync(join(tmpdir(), "vault-models-broken-")),
    realKey: (id) => (id === "anthropic" ? "sk-ant-real" : null),
    upstreams: { anthropic: { base: upBase, inject: inject.anthropic } },
    fetchImpl: async () => { throw new Error("upstream unreachable"); },
    port: 0,
  });
  const brokenAddr = await broken.listen();
  const brokenToken = broken.store.issue("desktop");
  try {
    const res = await fetch(`http://127.0.0.1:${brokenAddr.port}/models/anthropic`, {
      headers: { authorization: `Bearer ${brokenToken}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source, "fallback");
    assert.deepEqual(body.models.map((m) => m.id), ["claude-sonnet-4-6"]);
  } finally {
    await broken.close();
  }
});
