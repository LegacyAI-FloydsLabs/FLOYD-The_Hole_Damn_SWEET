import test from "node:test";
import assert from "node:assert/strict";
import { FloydApiError, FloydBrowserClient, FloydStreamIncompleteError } from "../browser/floyd-sdk.js";

test("browser client preserves Core status and error payload", async () => {
  const requests = [];
  const client = new FloydBrowserClient({
    baseUrl: "http://127.0.0.1:41414/",
    token: "browser-token",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request.clone());
      if (request.url.endsWith("/api/health")) {
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "permission expired", request_id: "per_1" }), {
        status: 410,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(await client.health(), { ok: true });
  assert.equal(requests[0].headers.get("authorization"), "Bearer browser-token");
  await assert.rejects(
    () => client.permission("ses_1", "per_1", "once", "cockpit"),
    (error) => error instanceof FloydApiError
      && error.status === 410
      && error.payload.request_id === "per_1",
  );
});

test("browser client calls an unbound fetch implementation safely", async () => {
  const receiver = { expected: true };
  function receiverSensitiveFetch() {
    assert.equal(this, globalThis);
    return Promise.resolve(new Response(JSON.stringify(receiver), { headers: { "content-type": "application/json" } }));
  }
  const client = new FloydBrowserClient({ token: "token", fetch: receiverSensitiveFetch });
  assert.deepEqual(await client.health(), receiver);
});

test("browser client omits an empty bearer header so HttpOnly device cookies remain authoritative", async () => {
  let seen;
  const client = new FloydBrowserClient({
    baseUrl: "https://floyd.test",
    token: () => "",
    fetch: async (input, init) => {
      seen = input instanceof Request ? input : new Request(input, init);
      return Response.json({ ok: true });
    },
  });
  assert.deepEqual(await client.health(), { ok: true });
  assert.equal(seen.headers.has("authorization"), false);
  assert.equal(seen.credentials, "same-origin");
});

test("browser model stream omits an empty Core token so an HttpOnly local session remains authoritative", async () => {
  let seen;
  const client = new FloydBrowserClient({
    baseUrl: "http://127.0.0.1:41414",
    token: () => "",
    fetch: async (input, init) => {
      seen = input instanceof Request ? input : new Request(input, init);
      return new Response('event: done\ndata: {"ok":true}\n\n', { headers: { "content-type": "text/event-stream" } });
    },
  });
  const events = [];
  for await (const event of client.modelStream({
    provider: "openai", apiKey: "provider-secret", model: "gpt-test", messages: [],
  })) events.push(event);
  assert.equal(seen.headers.has("x-floyd-token"), false);
  assert.equal(seen.credentials, "same-origin");
  assert.deepEqual(events, [{ type: "done", data: { ok: true } }]);
});

test("browser model stream rejects EOF without an explicit terminal event", async () => {
  const client = new FloydBrowserClient({
    token: "browser-token",
    fetch: async () => new Response(
      'event: delta\ndata: {"text":"partial"}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ),
  });
  const received = [];
  await assert.rejects(async () => {
    for await (const event of client.modelStream({
      provider: "openai",
      apiKey: "provider-secret",
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
    })) received.push(event);
  }, (error) => error instanceof FloydStreamIncompleteError
    && error.code === "upstream_stream_incomplete");
  assert.deepEqual(received, [{ type: "delta", data: { text: "partial" } }]);
});

test("browser model stream surfaces an explicit provider error without replacing it", async () => {
  const client = new FloydBrowserClient({
    token: "browser-token",
    fetch: async () => new Response(
      'event: error\ndata: {"error":{"type":"overloaded","message":"try later"}}',
      { headers: { "content-type": "text/event-stream" } },
    ),
  });
  const received = [];
  for await (const event of client.modelStream({
    provider: "openai",
    apiKey: "provider-secret",
    model: "gpt-test",
    messages: [{ role: "user", content: "hello" }],
  })) received.push(event);
  assert.deepEqual(received, [{
    type: "error",
    data: { error: { type: "overloaded", message: "try later" } },
  }]);
});
