// Vault proxy end-to-end tests: fake upstream, real HTTP, no network.
// Run: node --test apps/frame/test/vault-proxy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createVaultProxy, UPSTREAMS } from "../server/vault-proxy.mjs";
import { VAULT_PROVIDER_CATALOG } from "../../../lib/vault-provider-catalog.mjs";

// --- fake provider upstream: records auth headers, echoes a canned reply ----
const seen = [];
const fakeUpstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({
      path: req.url,
      method: req.method,
      auth: req.headers.authorization,
      xApiKey: req.headers["x-api-key"],
      xGoogApiKey: req.headers["x-goog-api-key"],
      xiApiKey: req.headers["xi-api-key"],
      userAgent: req.headers["user-agent"],
      body,
    });
    if (req.url?.includes("/status/429")) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
      return res.end('{"error":{"message":"matrix rate limit"}}');
    }
    if (req.url?.includes("/echo-secret")) {
      const secret = String(req.headers.authorization || "").replace(/^Bearer\s+/, "");
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "x-reflected-auth": secret,
      });
      res.write(`data: ${secret.slice(0, 7)}`);
      return res.end(`${secret.slice(7)}\n\n`);
    }
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

test("authenticated status reports the real Vault subscription state", async () => {
  const statusSecrets = mkdtempSync(join(tmpdir(), "vault-status-test-"));
  const secure = createVaultProxy({
    secretsDir: statusSecrets,
    realKey: () => null,
    upstreams: {},
    subscriptionStore: {
      read: () => ({ tokens: { access_token: "access", refresh_token: "refresh" } }),
      write: () => {},
    },
    port: 0,
  });
  const address = await secure.listen();
  const token = secure.store.issue("desktop");
  try {
    const denied = await fetch(`http://127.0.0.1:${address.port}/status`);
    assert.equal(denied.status, 401);
    const response = await fetch(`http://127.0.0.1:${address.port}/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      app: "desktop",
      subscriptionConfigured: true,
      configuredProviders: [],
      authority: "floyd-vault-keychain",
    });
  } finally {
    await secure.close();
  }
});

test("production proxy owns connector callback, management, and streaming invocation routes", async () => {
  const routeSecrets = mkdtempSync(join(tmpdir(), "vault-connector-routes-"));
  const calls = [];
  let closed = false;
  const secure = createVaultProxy({
    secretsDir: routeSecrets,
    realKey: () => null,
    upstreams: {},
    modelConnectors: {
      handleOAuthCallback: async (input) => {
        calls.push({ type: "callback", input });
        return { status: 303, location: "http://127.0.0.1:13021/settings/connectors?status=connected" };
      },
      dispatch: async (input) => {
        calls.push({ type: "dispatch", input });
        return { status: 200, body: { connectors: [{ id: "proof" }] } };
      },
      invoke: async (input) => {
        calls.push({ type: "invoke", input });
        return new Response('data: {"ok":true}\n\n', {
          status: 202,
          headers: { "content-type": "text/event-stream", "request-id": "proof-request" },
        });
      },
      close: async () => { closed = true; },
    },
    port: 0,
  });
  const address = await secure.listen();
  const routeBase = `http://127.0.0.1:${address.port}`;
  const token = secure.store.issue("core");
  try {
    const callback = await fetch(`${routeBase}/connectors/oauth/callback?state=proof-state&code=proof-code`, {
      redirect: "manual",
    });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get("location"), "http://127.0.0.1:13021/settings/connectors?status=connected");
    assert.equal(callback.headers.get("cache-control"), "no-store");
    assert.equal(callback.headers.get("referrer-policy"), "no-referrer");

    const list = await fetch(`${routeBase}/connectors`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.deepEqual(await list.json(), { connectors: [{ id: "proof" }] });

    const invoke = await fetch(`${routeBase}/connectors/proof/invoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "proof-model", messages: [] }),
    });
    assert.equal(invoke.status, 202);
    assert.equal(invoke.headers.get("content-type"), "text/event-stream");
    assert.equal(invoke.headers.get("request-id"), "proof-request");
    assert.equal(await invoke.text(), 'data: {"ok":true}\n\n');
    assert.equal(calls[0].type, "callback");
    assert.equal(calls[0].input.state, "proof-state");
    assert.equal(calls[0].input.code, "proof-code");
    assert.equal(calls[1].type, "dispatch");
    assert.equal(calls[1].input.app, "core");
    assert.equal(calls[2].type, "invoke");
    assert.equal(calls[2].input.app, "core");
    assert.equal(calls[2].input.connectorId, "proof");
  } finally {
    await secure.close();
  }
  assert.equal(closed, true);
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

test("provider response cannot echo a real key in headers or a streamed body", async () => {
  const token = proxy.store.ensure("testapp2");
  const res = await fetch(`${base}/p/zai/echo-secret`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.doesNotMatch(res.headers.get("x-reflected-auth") || "", /real-zai-key/);
  const body = await res.text();
  assert.doesNotMatch(body, /real-zai-key/);
  assert.match(body, /FLOYD_VAULT_REDACTED/);
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

test("provider catalog routes every credential placement and native surface without leaking fv tokens", async () => {
  const matrixSecrets = mkdtempSync(join(tmpdir(), "vault-provider-matrix-"));
  const keys = Object.fromEntries(Object.keys(UPSTREAMS).map((id) => [id, `matrix-real-${id}`]));
  const upstreams = Object.fromEntries(Object.entries(UPSTREAMS).map(([id, spec]) => [id, {
    ...spec,
    base: upBase,
    openai: spec.openai ? `${upBase}/chat/completions` : undefined,
    anthropic: spec.anthropic ? `${upBase}/messages` : undefined,
  }]));
  const matrix = createVaultProxy({
    secretsDir: matrixSecrets,
    realKey: (id) => keys[id] || null,
    upstreams,
    port: 0,
  });
  const matrixAddress = await matrix.listen();
  const matrixBase = `http://127.0.0.1:${matrixAddress.port}`;
  const token = matrix.store.issue("matrix");
  const placements = ["authorization", "x-api-key", "xi-api-key", "x-goog-api-key", "query", "body"];
  const ids = Object.keys(UPSTREAMS);
  try {
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      const placement = placements[index % placements.length];
      const headers = { "content-type": "application/json" };
      let path = `/p/${id}/surface/${VAULT_PROVIDER_CATALOG[id].capabilities[0]}`;
      let payload = { model: "matrix", temperature: 0.2, tool: { name: "proof" } };
      if (placement === "authorization") headers.authorization = `Bearer ${token}`;
      if (placement === "x-api-key") headers["x-api-key"] = token;
      if (placement === "xi-api-key") headers["xi-api-key"] = token;
      if (placement === "x-goog-api-key") headers["x-goog-api-key"] = token;
      if (placement === "query") path += `?key=${encodeURIComponent(token)}`;
      if (placement === "body") payload.api_key = token;
      const response = await fetch(matrixBase + path, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 200, `${id} did not route`);
      const hit = seen.at(-1);
      assert.ok(!JSON.stringify(hit).includes("fv_"), `${id} leaked its application capability upstream`);
      if (VAULT_PROVIDER_CATALOG[id].auth === "anthropic") assert.equal(hit.xApiKey, keys[id]);
      else if (VAULT_PROVIDER_CATALOG[id].auth === "google") assert.equal(hit.xGoogApiKey, keys[id]);
      else if (VAULT_PROVIDER_CATALOG[id].auth === "elevenlabs") assert.equal(hit.xiApiKey, keys[id]);
      else if (VAULT_PROVIDER_CATALOG[id].auth === "fal") assert.equal(hit.auth, `Key ${keys[id]}`);
      else assert.equal(hit.auth, `Bearer ${keys[id]}`);
      if (id === "moonshot") assert.equal(JSON.parse(hit.body).temperature, 1);
    }

    const error = await fetch(`${matrixBase}/p/zai/status/429`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(error.status, 429);
    assert.equal(error.headers.get("retry-after"), "7");
    assert.deepEqual(await error.json(), { error: { message: "matrix rate limit" } });
    assert.ok(matrix.store.list().find((entry) => entry.app === "matrix")?.routes?.zai?.success_count > 0);
  } finally {
    await matrix.close();
  }
});

test("Google Live WebSocket swaps the fv query token before its upstream handshake", async () => {
  let upstreamPath = "";
  let liveUpstreamSocket;
  const liveUpstream = http.createServer();
  liveUpstream.on("upgrade", (req, socket) => {
    liveUpstreamSocket = socket;
    upstreamPath = req.url || "";
    const accept = createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n"
      + "Connection: Upgrade\r\n"
      + "Upgrade: websocket\r\n"
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  await new Promise((resolve) => liveUpstream.listen(0, "127.0.0.1", resolve));
  const liveSecrets = mkdtempSync(join(tmpdir(), "vault-live-websocket-"));
  const realGoogleKey = "real-google-live-key";
  const liveProxy = createVaultProxy({
    secretsDir: liveSecrets,
    realKey: (id) => id === "google" ? realGoogleKey : null,
    upstreams: {},
    googleWebSocketBase: `http://127.0.0.1:${liveUpstream.address().port}`,
    port: 0,
  });
  const liveAddress = await liveProxy.listen();
  const token = liveProxy.store.issue("ttybridge");
  try {
    const receipt = await new Promise((resolve, reject) => {
      const client = net.connect(liveAddress.port, "127.0.0.1", () => {
        client.write(
          "GET /p/google/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
          + `?key=${encodeURIComponent(token)} HTTP/1.1\r\n`
          + `Host: 127.0.0.1:${liveAddress.port}\r\n`
          + "Connection: Upgrade\r\n"
          + "Upgrade: websocket\r\n"
          + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
          + "Sec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      let response = "";
      client.on("data", (chunk) => {
        response += chunk;
        if (response.includes("\r\n\r\n")) {
          client.destroy();
          resolve(response);
        }
      });
      client.on("error", reject);
    });
    assert.match(receipt, /^HTTP\/1\.1 101/);
    assert.equal(
      upstreamPath,
      `/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${realGoogleKey}`,
    );
    assert.ok(!upstreamPath.includes("fv_"));
    assert.ok(liveProxy.store.list().find((entry) => entry.app === "ttybridge")?.routes?.google?.success_count > 0);
  } finally {
    await liveProxy.close();
    liveUpstreamSocket?.destroy();
    await new Promise((resolve) => liveUpstream.close(resolve));
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

test("revoking an fv token aborts its active HTTP stream immediately", async () => {
  let upstreamClosed = false;
  const slowUpstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    res.once("close", () => { upstreamClosed = true; });
  });
  await new Promise((resolve) => slowUpstream.listen(0, "127.0.0.1", resolve));
  const streamSecrets = mkdtempSync(join(tmpdir(), "vault-stream-revoke-"));
  const streamProxy = createVaultProxy({
    secretsDir: streamSecrets,
    realKey: () => "real-stream-key",
    upstreams: {
      zai: {
        base: `http://127.0.0.1:${slowUpstream.address().port}`,
        openai: `http://127.0.0.1:${slowUpstream.address().port}/stream`,
        inject: (headers, key) => { headers.authorization = `Bearer ${key}`; },
      },
    },
    port: 0,
  });
  const streamAddress = await streamProxy.listen();
  const token = streamProxy.store.ensure("stream-app");
  try {
    const receipt = await new Promise((resolve, reject) => {
      let rotated = null;
      let completed = false;
      const request = http.request({
        host: "127.0.0.1",
        port: streamAddress.port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      });
      request.on("response", (response) => {
        response.once("error", (error) => {
          if (rotated) {
            resolve({ completed, rotation: rotated });
          } else {
            reject(error);
          }
        });
        response.once("end", () => { completed = true; });
        response.once("data", () => {
          rotated = streamProxy.store.rotate("stream-app", {
            source: "test",
            reason: "active stream compromise",
          });
          response.once("close", () => resolve({ completed, rotation: rotated }));
        });
      });
      request.once("error", (error) => {
        if (rotated && error.message === "Vault capability revoked") {
          resolve({ completed, rotation: rotated });
        } else {
          reject(error);
        }
      });
      request.end(JSON.stringify({ model: "zai/glm-4.7", messages: [] }));
    });
    assert.equal(receipt.completed, false);
    assert.ok(receipt.rotation.terminatedConnections >= 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(upstreamClosed, true);
  } finally {
    await streamProxy.close();
    await new Promise((resolve) => slowUpstream.close(resolve));
  }
});
