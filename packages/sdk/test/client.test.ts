import test from "node:test";
import assert from "node:assert/strict";
import { FloydApiError, FloydClient, FloydModelClient, FloydStreamIncompleteError } from "../src/index.ts";

test("client forwards bearer auth, JSON, and exact upstream errors", async () => {
  const seen: Request[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    seen.push(request.clone());
    if (new URL(request.url).pathname === "/api/fail") {
      return new Response(JSON.stringify({ error: "rate limited", retry_after: 30 }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  };
  const client = new FloydClient({ baseUrl: "http://127.0.0.1:41414/", token: async () => "secret", fetch: fetchMock });

  assert.deepEqual(await client.submit({ project_id: "prj_1", goal: "make it work" }), { ok: true });
  assert.equal(seen[0]?.headers.get("authorization"), "Bearer secret");
  assert.deepEqual(JSON.parse(await seen[0]!.text()), { project_id: "prj_1", goal: "make it work" });

  await assert.rejects(
    () => client.request("GET", "/api/fail"),
    (error: unknown) => {
      assert.ok(error instanceof FloydApiError);
      assert.equal(error.status, 429);
      assert.deepEqual(error.payload, { error: "rate limited", retry_after: 30 });
      return true;
    },
  );
});

test("client omits an empty bearer header for cookie-authenticated remote surfaces", async () => {
  let seen: Request | undefined;
  const client = new FloydClient({
    token: "",
    fetch: async (input, init) => {
      seen = input instanceof Request ? input : new Request(input, init);
      return Response.json({ ok: true });
    },
  });
  assert.deepEqual(await client.health(), { ok: true });
  assert.equal(seen?.headers.has("authorization"), false);
});

test("SSE parser normalizes CRLF, multiline data, resume id, and cancels on break", async () => {
  let cancelled = false;
  let lastEventId: string | null = null;
  const encoder = new TextEncoder();
  const fetchMock: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    lastEventId = request.headers.get("last-event-id");
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('id: 41\r\nevent: token\r\ndata: {"delta":\r\ndata: "hello"}\r\n\r\n'));
      },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
  };
  const client = new FloydClient({ token: "token", fetch: fetchMock });
  const events = client.attachSession("ses 1", "desktop", { lastEventId: "40" });
  for await (const event of events) {
    assert.deepEqual(event, { id: "41", type: "token", data: { delta: "hello" } });
    break;
  }
  assert.equal(lastEventId, "40");
  assert.equal(cancelled, true);
});

test("aborting a surface stream propagates to the network request", async () => {
  let networkAborted = false;
  const fetchMock: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return new Response(new ReadableStream({
      start(controller) {
        if (request.signal.aborted) {
          networkAborted = true;
          controller.error(new DOMException("aborted", "AbortError"));
          return;
        }
        request.signal.addEventListener("abort", () => {
          networkAborted = true;
          controller.error(new DOMException("aborted", "AbortError"));
        }, { once: true });
      },
    }), { headers: { "content-type": "text/event-stream" } });
  };
  const client = new FloydClient({ token: "token", fetch: fetchMock });
  const controller = new AbortController();
  const iterator = client.watchRun("run_1", controller.signal);
  const pending = iterator.next();
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.equal(networkAborted, true);
});

test("model driver sends only Core auth and provider selection", async () => {
  let seen: Request | undefined;
  let cancelled = false;
  const fetchMock: typeof fetch = async (input, init) => {
    seen = input instanceof Request ? input : new Request(input, init);
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'event: delta\ndata: {"text":"hello"}\n\nevent: done\ndata: {"finish_reason":"stop"}\n\n',
        ));
      },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
  };
  const client = new FloydModelClient({ token: "core-secret", fetch: fetchMock });
  const events = client.streamChat({
    route: { provider: "moonshot" },
    model: "kimi-test",
    messages: [{ role: "user", content: "build it" }],
  });
  const first = await events.next();
  assert.deepEqual(first.value, { type: "delta", data: { text: "hello" } });
  await events.return(undefined);
  assert.equal(seen?.headers.get("x-floyd-token"), "core-secret");
  assert.equal(seen?.headers.get("authorization"), null);
  assert.equal(seen?.headers.get("x-api-key"), null);
  assert.equal(seen?.headers.get("x-floyd-provider"), "moonshot");
  assert.equal(cancelled, true);
});

test("model driver preserves exact relay errors without accepting Anthropic credentials", async () => {
  let seen: Request | undefined;
  const fetchMock: typeof fetch = async (input, init) => {
    seen = input instanceof Request ? input : new Request(input, init);
    return new Response('{"error":{"message":"bad key"}}', {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new FloydModelClient({ token: "core-secret", fetch: fetchMock });
  await assert.rejects(
    async () => {
      for await (const _event of client.streamChat({
        route: { provider: "anthropic" },
        model: "claude-test",
        messages: [{ role: "user", content: "hello" }],
      })) { /* no frames on error */ }
    },
    (error: unknown) => {
      assert.ok(error instanceof FloydApiError);
      assert.equal(error.status, 401);
      assert.deepEqual(error.payload, { error: { message: "bad key" } });
      return true;
    },
  );
  assert.equal(seen?.headers.get("x-api-key"), null);
  assert.equal(seen?.headers.get("anthropic-version"), null);
  assert.equal(seen?.headers.get("authorization"), null);
});

test("model driver ignores obsolete direct-key, reference, and address fields", async () => {
  let seen: Request | undefined;
  const fetchMock: typeof fetch = async (input, init) => {
    seen = input instanceof Request ? input : new Request(input, init);
    return new Response('event: error\ndata: {"error":{"type":"overloaded"}}\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const client = new FloydModelClient({ token: "core-secret", fetch: fetchMock });
  const received = [];
  for await (const _event of client.streamChat({
    route: {
      provider: "openai",
      apiKey: "must-not-travel",
      credentialRef: "floyd-connector:retired",
      baseUrl: "https://api.openai.com/v1",
    } as never,
    model: "gpt-test",
    messages: [{ role: "user", content: "hello" }],
  })) { received.push(_event); }
  assert.deepEqual(received, [{ type: "error", data: { error: { type: "overloaded" } } }]);
  assert.equal(seen?.headers.get("x-floyd-credential-ref"), null);
  assert.equal(seen?.headers.get("x-floyd-base-url"), null);
  assert.equal(seen?.headers.get("authorization"), null);
  assert.equal(seen?.headers.get("x-api-key"), null);
  assert.doesNotMatch(String(await seen?.clone().text()), /must-not-travel|floyd-connector|api\.openai\.com/);
});

test("model driver rejects EOF without an explicit done or error terminal", async () => {
  const fetchMock: typeof fetch = async () => new Response(
    'event: delta\ndata: {"text":"partial"}\n\n',
    { headers: { "content-type": "text/event-stream" } },
  );
  const client = new FloydModelClient({ token: "core-secret", fetch: fetchMock });
  const received: unknown[] = [];
  await assert.rejects(async () => {
    for await (const event of client.streamChat({
      route: { provider: "openai" },
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
    })) received.push(event);
  }, (error: unknown) => error instanceof FloydStreamIncompleteError
    && error.code === "upstream_stream_incomplete");
  assert.deepEqual(received, [{ type: "delta", data: { text: "partial" } }]);
});
