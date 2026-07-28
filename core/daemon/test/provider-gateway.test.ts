import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import {
  normalizeProviderFrame,
  relayProviderRequest,
  resolveProviderEndpoint,
  translatePayload,
} from "../src/provider-gateway.ts";
import type { CoreVaultCapability } from "../src/vault-capability.ts";

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP port");
  return address.port;
}

async function close(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

function createRelayServer(vaultCapability: CoreVaultCapability): Server {
  return createServer((req, res) => {
    void relayProviderRequest(req, res, undefined, { vaultCapability }).catch((error) => {
      if (res.headersSent) return res.destroy(error);
      res.writeHead(Number(error.statusCode ?? 500), { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    });
  });
}

const CORE_VAULT_TOKEN = "fv_core_0123456789abcdef0123456789abcdef0123456789abcdef";

function coreVaultCapability(port: number): CoreVaultCapability {
  return {
    token: CORE_VAULT_TOKEN,
    proxy: `http://127.0.0.1:${port}`,
    source: "floyd-vault:core",
  };
}

test("routes Vault-compatible endpoints to the invariant completion paths", () => {
  assert.equal(resolveProviderEndpoint("zai", "http://127.0.0.1:13031/v1", "glm").endpoint.href, "http://127.0.0.1:13031/v1/chat/completions");
  assert.equal(resolveProviderEndpoint("moonshot", "http://127.0.0.1:13031/v1", "kimi").endpoint.href, "http://127.0.0.1:13031/v1/chat/completions");
  assert.equal(resolveProviderEndpoint("anthropic", "http://127.0.0.1:13031/v1/chat/completions", "claude-x").endpoint.href, "http://127.0.0.1:13031/v1/messages");
  assert.throws(() => resolveProviderEndpoint("openai", "http://public.example/v1", "gpt"), /HTTPS/);
});

test("translates Anthropic system messages and normalizes both stream dialects", () => {
  const translated = translatePayload({
    model: "claude-test",
    stream: true,
    messages: [
      { role: "system", content: "first" },
      { role: "system", content: [{ type: "text", text: "second" }] },
      { role: "user", content: "hello" },
    ],
  }, "anthropic");
  assert.equal(translated.system, "first\n\nsecond");
  assert.deepEqual(translated.messages, [{ role: "user", content: "hello" }]);
  assert.deepEqual(normalizeProviderFrame("openai", { choices: [{ delta: { content: "A" } }] }), { text: "A" });
  assert.deepEqual(normalizeProviderFrame("anthropic", { type: "content_block_delta", delta: { type: "text_delta", text: "B" } }), { text: "B" });
});

test("relay preserves bearer auth and produces one normalized SSE contract", async () => {
  let seenPath = "";
  let seenAuthorization = "";
  let seenBody: unknown;
  const upstream = createServer(async (req, res) => {
    seenPath = req.url ?? "";
    seenAuthorization = req.headers.authorization ?? "";
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    seenBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n');
    res.end("data: [DONE]\n\n");
  });
  const upstreamPort = await listen(upstream);
  const relay = createRelayServer(coreVaultCapability(upstreamPort));
  const relayPort = await listen(relay);
  try {
    const response = await fetch(`http://127.0.0.1:${relayPort}/gateway`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-floyd-provider": "openai",
      },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), [
      'event: delta\ndata: {"text":"hel"}\n\n',
      'event: delta\ndata: {"text":"lo"}\n\n',
      'event: done\ndata: {"finish_reason":"stop"}\n\n',
    ].join(""));
    assert.equal(seenPath, "/v1/chat/completions");
    assert.equal(seenAuthorization, `Bearer ${CORE_VAULT_TOKEN}`);
    assert.deepEqual(seenBody, { model: "openai/gpt-test", messages: [{ role: "user", content: "hi" }], stream: true });
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("relay echoes the vendor's exact non-200 status and error payload", async () => {
  const upstream = createServer((_req, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "17" });
    res.end('{"error":{"type":"rate_limit","message":"slow down"}}');
  });
  const upstreamPort = await listen(upstream);
  const relay = createRelayServer(coreVaultCapability(upstreamPort));
  const relayPort = await listen(relay);
  try {
    const response = await fetch(`http://127.0.0.1:${relayPort}/gateway`, {
      method: "POST",
      headers: {
        "x-floyd-provider": "anthropic",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "claude-test", messages: [{ role: "system", content: "code" }, { role: "user", content: "hi" }], stream: true }),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "17");
    assert.equal(await response.text(), '{"error":{"type":"rate_limit","message":"slow down"}}');
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("relay rejects every direct credential and provider-address override", async () => {
  let requestCount = 0;
  const upstream = createServer((_req, res) => {
    requestCount += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  const vaultCapability = coreVaultCapability(upstreamPort);
  const relay = createServer((req, res) => { void relayProviderRequest(req, res, undefined, { vaultCapability }).catch((error) => {
    res.writeHead(Number(error.statusCode ?? 500), { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  }); });
  const relayPort = await listen(relay);
  try {
    const body = JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }], stream: false });
    const credential = await fetch(`http://127.0.0.1:${relayPort}/gateway`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer forbidden-real-key" },
      body,
    });
    assert.equal(credential.status, 400);
    assert.match(await credential.text(), /accept no provider credential/);

    const substituted = await fetch(`http://127.0.0.1:${relayPort}/gateway`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-floyd-base-url": "http://127.0.0.1:9/v1" },
      body,
    });
    assert.equal(substituted.status, 400);
    assert.match(await substituted.text(), /accept no provider credential or provider address/);
    assert.equal(requestCount, 0);
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("relay preserves provider errors delivered inside a successful SSE response", async () => {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('event: error\ndata: {"error":{"type":"overloaded","message":"try later"}}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"must-not-follow"}}]}\n\n');
    res.end("data: [DONE]\n\n");
  });
  const upstreamPort = await listen(upstream);
  const relay = createRelayServer(coreVaultCapability(upstreamPort));
  const relayPort = await listen(relay);
  try {
    const response = await fetch(`http://127.0.0.1:${relayPort}/gateway`, {
      method: "POST",
      headers: {
        "x-floyd-provider": "openai",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'event: error\ndata: {"error":{"type":"overloaded","message":"try later"}}\n\n');
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("relay reports a clean upstream EOF without a provider terminal as incomplete", async () => {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  });
  const upstreamPort = await listen(upstream);
  const relay = createRelayServer(coreVaultCapability(upstreamPort));
  const relayPort = await listen(relay);
  try {
    const response = await fetch(`http://127.0.0.1:${relayPort}/gateway`, {
      method: "POST",
      headers: {
        "x-floyd-provider": "openai",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), [
      'event: delta\ndata: {"text":"partial"}\n\n',
      'event: error\ndata: {"error":{"type":"upstream_stream_incomplete","message":"provider stream ended before an explicit terminal event"}}\n\n',
    ].join(""));
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("relay terminates an oversized provider SSE frame with a normalized error", async () => {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${"x".repeat(1024 * 1024 + 1)}`);
  });
  const upstreamPort = await listen(upstream);
  const relay = createRelayServer(coreVaultCapability(upstreamPort));
  const relayPort = await listen(relay);
  try {
    const response = await fetch(`http://127.0.0.1:${relayPort}/gateway`, {
      method: "POST",
      headers: {
        "x-floyd-provider": "openai",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-test", messages: [], stream: true }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /relay_frame_too_large/);
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("client abort destroys the active upstream response/socket", async () => {
  let upstreamClosed = false;
  const upstream = createServer((_req, res) => {
    res.on("close", () => { upstreamClosed = true; });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"open"}}]}\n\n');
  });
  const upstreamPort = await listen(upstream);
  const vaultCapability = coreVaultCapability(upstreamPort);
  const relay = createServer((req, res) => { void relayProviderRequest(req, res, undefined, { vaultCapability }).catch(() => {}); });
  const relayPort = await listen(relay);
  try {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${relayPort}/gateway`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-floyd-provider": "openai",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    assert.equal(response.status, 200);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(upstreamClosed, true);
  } finally {
    await close(relay);
    await close(upstream);
  }
});
