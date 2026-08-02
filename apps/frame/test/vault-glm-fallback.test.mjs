// GLM always-fallback (D3/D4/D5) + catalog live-merge tests: fake upstream,
// real HTTP, no network. Run: node --test apps/frame/test/vault-glm-fallback.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createVaultProxy, mergeLiveProviderModels } from "../server/vault-proxy.mjs";

// --- fake provider upstream: chat + models, per-test controllable status ----
const mode = { deepseekChat: 200, zaiChat: 200, zaiAnthropicChat: 200 };
const seen = { zaiChatBody: null, zaiAnthropicBody: null, deepseekHits: 0 };
const fakeUpstream = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/coding/paas/v4/models") {
      res.writeHead(200);
      return res.end(JSON.stringify({ object: "list", data: [
        { id: "glm-5.2", object: "model", owned_by: "z-ai" },
        { id: "glm-4.7", object: "model", owned_by: "z-ai" },
      ] }));
    }
    if (req.url === "/api/coding/paas/v4/chat/completions") {
      seen.zaiChatBody = JSON.parse(raw || "{}");
      res.writeHead(mode.zaiChat);
      return res.end(mode.zaiChat === 200
        ? JSON.stringify({ id: "chatcmpl-zai", choices: [{ index: 0, message: { role: "assistant", content: "glm here" }, finish_reason: "stop" }] })
        : JSON.stringify({ error: { message: "zai broke" } }));
    }
    if (req.url === "/api/anthropic/v1/messages") {
      seen.zaiAnthropicBody = JSON.parse(raw || "{}");
      res.writeHead(mode.zaiAnthropicChat);
      return res.end(mode.zaiAnthropicChat === 200
        ? JSON.stringify({ id: "msg_zai", type: "message", role: "assistant", content: [{ type: "text", text: "glm here" }] })
        : JSON.stringify({ error: { message: "zai broke" } }));
    }
    if (req.url === "/chat/completions") { // deepseek openai-dialect route
      seen.deepseekHits += 1;
      res.writeHead(mode.deepseekChat);
      return res.end(mode.deepseekChat === 200
        ? JSON.stringify({ id: "chatcmpl-ds", choices: [{ index: 0, message: { role: "assistant", content: "deepseek here" }, finish_reason: "stop" }] })
        : JSON.stringify({ error: { message: `deepseek HTTP ${mode.deepseekChat}` } }));
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
});
await new Promise((r) => fakeUpstream.listen(0, "127.0.0.1", r));
const upBase = `http://127.0.0.1:${fakeUpstream.address().port}`;

let KEYS = { zai: "real-zai-key" }; // replaced per test
const inject = {
  bearer: (h, k) => { h.authorization = `Bearer ${k}`; },
  anthropic: (h, k) => { h["x-api-key"] = k; },
};
const proxy = createVaultProxy({
  secretsDir: mkdtempSync(join(tmpdir(), "vault-fallback-test-")),
  realKey: (id) => KEYS[id] || null,
  upstreams: {
    zai: { base: upBase, openai: `${upBase}/api/coding/paas/v4/chat/completions`, anthropic: `${upBase}/api/anthropic/v1/messages`, inject: inject.bearer },
    deepseek: { base: upBase, openai: `${upBase}/chat/completions`, inject: inject.bearer },
    anthropic: { base: upBase, anthropic: `${upBase}/v1/messages`, inject: inject.anthropic },
  },
  port: 0,
});
const addr = await proxy.listen();
const base = `http://127.0.0.1:${addr.port}`;
const token = proxy.store.issue("desktop");
const authed = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const chat = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: authed, body: JSON.stringify(body) });

test.after(async () => { await proxy.close(); fakeUpstream.close(); });

test("no-key provider falls back to zai with marker headers and records the actual route", async () => {
  KEYS = { zai: "real-zai-key" };
  mode.deepseekChat = 200;
  mode.zaiChat = 200;
  const res = await chat("/v1/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-floyd-fallback"), "deepseek");
  assert.equal(res.headers.get("x-floyd-fallback-model"), "glm-5.2"); // live broker's first entry, not static glm-4.7
  assert.equal(seen.zaiChatBody.model, "glm-5.2");
  assert.equal(seen.deepseekHits, 0); // never attempted the keyless provider
  const body = await res.json();
  assert.equal(body.choices[0].message.content, "glm here");
  const routes = proxy.store.list().find((t) => t.app === "desktop").routes;
  assert.equal(routes["zai:fallback-from-deepseek"].success_count >= 1, true);
  assert.equal(routes.deepseek, undefined); // the failed provider is not credited
});

test("anthropic-dialect request with no key falls back to zai's anthropic route", async () => {
  KEYS = { zai: "real-zai-key" };
  mode.zaiAnthropicChat = 200;
  const res = await chat("/v1/messages", { model: "claude-opus-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-floyd-fallback"), "anthropic");
  assert.equal(seen.zaiAnthropicBody.model, "glm-5.2");
  assert.equal(seen.zaiAnthropicBody.max_tokens, 8); // body preserved apart from the model rewrite
  const body = await res.json();
  assert.equal(body.content[0].text, "glm here");
});

test("HTTP 5xx from the primary upstream triggers the fallback", async () => {
  KEYS = { zai: "real-zai-key", deepseek: "sk-deepseek-real" };
  mode.deepseekChat = 503;
  mode.zaiChat = 200;
  const res = await chat("/v1/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-floyd-fallback"), "deepseek");
  assert.equal(seen.deepseekHits >= 1, true); // primary was attempted first
  const body = await res.json();
  assert.equal(body.choices[0].message.content, "glm here");
});

test("HTTP 4xx passes through unchanged — no fallback", async () => {
  KEYS = { zai: "real-zai-key", deepseek: "sk-deepseek-real" };
  mode.deepseekChat = 429;
  const zaiBodyBefore = seen.zaiChatBody;
  const res = await chat("/v1/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("x-floyd-fallback"), null);
  assert.equal(seen.zaiChatBody, zaiBodyBefore); // zai never invoked
  const body = await res.json();
  assert.equal(body.error.message, "deepseek HTTP 429");
});

test("already-zai never falls back to itself", async () => {
  KEYS = { zai: "real-zai-key" };
  mode.zaiChat = 503;
  const res = await chat("/v1/chat/completions", { model: "glm-4.7", messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("x-floyd-fallback"), null);
  const body = await res.json();
  assert.equal(body.error.message, "zai broke");
});

test("a primary network error triggers the fallback", async () => {
  mode.zaiChat = 200;
  const flaky = createVaultProxy({
    secretsDir: mkdtempSync(join(tmpdir(), "vault-fallback-flaky-")),
    realKey: (id) => ({ zai: "real-zai-key", deepseek: "sk-deepseek-real" })[id] || null,
    upstreams: {
      zai: { base: upBase, openai: `${upBase}/api/coding/paas/v4/chat/completions`, inject: inject.bearer },
      deepseek: { base: upBase, openai: `${upBase}/chat/completions`, inject: inject.bearer },
    },
    fetchImpl: (url, opts) => String(url) === `${upBase}/chat/completions`
      ? Promise.reject(new Error("connect ECONNREFUSED"))
      : fetch(url, opts),
    port: 0,
  });
  const flakyAddr = await flaky.listen();
  const flakyToken = flaky.store.issue("desktop");
  try {
    const res = await fetch(`http://127.0.0.1:${flakyAddr.port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${flakyToken}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-floyd-fallback"), "deepseek");
    assert.equal(res.headers.get("x-floyd-fallback-model"), "glm-5.2");
  } finally {
    await flaky.close();
  }
});

test("static catalog model is used when the live broker is unreachable", async () => {
  const blind = createVaultProxy({
    secretsDir: mkdtempSync(join(tmpdir(), "vault-fallback-blind-")),
    realKey: (id) => (id === "zai" ? "real-zai-key" : null),
    upstreams: {
      zai: { base: upBase, openai: `${upBase}/api/coding/paas/v4/chat/completions`, inject: inject.bearer },
      deepseek: { base: upBase, openai: `${upBase}/chat/completions`, inject: inject.bearer },
    },
    fetchImpl: (url, opts) => String(url).includes("/models")
      ? Promise.reject(new Error("models endpoint down"))
      : fetch(url, opts),
    port: 0,
  });
  const blindAddr = await blind.listen();
  const blindToken = blind.store.issue("desktop");
  try {
    const res = await fetch(`http://127.0.0.1:${blindAddr.port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${blindToken}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-floyd-fallback"), "deepseek");
    assert.equal(res.headers.get("x-floyd-fallback-model"), "glm-4.7"); // catalog static zai model
  } finally {
    await blind.close();
  }
});

test("catalog merge serves live models with per-provider source fields", async () => {
  KEYS = { zai: "real-zai-key" };
  const live = await proxy.liveProviderModels(["zai", "deepseek", "github"]);
  assert.deepEqual(Object.keys(live), ["zai"]); // unkeyed providers are left to the static list
  assert.deepEqual(live.zai.models, ["glm-5.2", "glm-4.7"]);
  assert.equal(live.zai.source, "live");
  const merged = mergeLiveProviderModels([
    { id: "zai", name: "Z.ai GLM Coding", models: ["glm-4.7"], configured: true },
    { id: "deepseek", name: "DeepSeek", models: ["deepseek-chat"], configured: false },
  ], live);
  assert.deepEqual(merged[0].models, ["glm-5.2", "glm-4.7"]); // static list replaced by the live one
  assert.equal(merged[0].source, "live");
  assert.equal(merged[0].configured, true); // existing consumer fields untouched
  assert.deepEqual(merged[1].models, ["deepseek-chat"]);
  assert.equal(merged[1].source, "fallback");
});
