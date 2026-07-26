import test from "node:test";
import assert from "node:assert/strict";
import {
  ConnectedAppTransport,
  ConnectedAppTransportError,
} from "../src/connected-app-transport.ts";
import type { ResolvedConnectedAppCredential } from "../src/connected-app-authority.ts";

const RESOURCE = "https://mcp.example.test/exact/resource";
const SECRET = "super-secret-access-token";

function credential(authorization = `bEaReR   ${SECRET}`): ResolvedConnectedAppCredential {
  return {
    credentialRef: "floyd-connected-app:notes",
    connectorId: "notes",
    resourceUrl: RESOURCE,
    authorization,
    expiresAt: null,
  };
}

test("initializes the exact resource, canonicalizes Bearer, retains session privately, and parses JSON/SSE", async () => {
  const requests: Request[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request.clone());
    const body = request.method === "POST" ? JSON.parse(await request.text()) as Record<string, unknown> : null;
    if (body?.method === "initialize") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { protocolVersion: "2025-06-18", serverInfo: { name: "notes" }, echoed: `Bearer ${SECRET}` },
      }), {
        headers: { "content-type": "application/json", "mcp-session-id": "session-47" },
      });
    }
    if (body?.method === "notifications/initialized") return new Response(null, { status: 202 });
    return new Response([
      'event: message\r\ndata: {"jsonrpc":"2.0","id":2,\r\n',
      'data: "error":{"code":-32001,"message":"denied"}}\r\n\r\n',
    ].join(""), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
  };
  const transport = new ConnectedAppTransport(credential(), { fetch: fetchMock });
  const initialized = await transport.initialize({
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "Floyd Core", version: "1" },
  });
  assert.equal(initialized.status, 200);
  assert.deepEqual(initialized.messages, [{
    jsonrpc: "2.0",
    id: 1,
    result: { protocolVersion: "2025-06-18", serverInfo: { name: "notes" }, echoed: "[REDACTED]" },
  }]);
  const called = await transport.call("tools/list");
  assert.deepEqual(called.messages, [{ jsonrpc: "2.0", id: 2, error: { code: -32001, message: "denied" } }]);

  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.url, RESOURCE);
    assert.equal(request.redirect, "manual");
    assert.equal(request.headers.get("authorization"), `Bearer ${SECRET}`);
  }
  assert.equal(requests[0]!.headers.get("mcp-session-id"), null);
  assert.equal(requests[0]!.headers.get("mcp-protocol-version"), null);
  assert.equal(requests[1]!.headers.get("mcp-session-id"), "session-47");
  assert.equal(requests[2]!.headers.get("mcp-session-id"), "session-47");
  assert.equal(requests[1]!.headers.get("mcp-protocol-version"), "2025-06-18");
  assert.equal(requests[2]!.headers.get("mcp-protocol-version"), "2025-06-18");
  assert.doesNotMatch(JSON.stringify(initialized), /super-secret|authorization/i);
  assert.doesNotMatch(JSON.stringify(called), /super-secret|authorization/i);
});

test("preserves upstream status/error while redacting echoed authorization and never follows redirects", async () => {
  let mode: "rate" | "redirect" = "rate";
  let calls = 0;
  const fetchMock: typeof fetch = async (_input, init) => {
    calls += 1;
    assert.equal(init?.redirect, "manual");
    if (mode === "redirect") {
      return new Response("moved", { status: 307, headers: { location: "https://hostile.example/collect" } });
    }
    return new Response(JSON.stringify({
      error: { code: "rate_limited", message: `retry; authorization=Bearer ${SECRET}` },
      authorization: `Bearer ${SECRET}`,
    }), { status: 429, headers: { "content-type": "application/json" } });
  };
  const transport = new ConnectedAppTransport(credential(), { fetch: fetchMock });
  await assert.rejects(() => transport.call("tools/call", {}), (error: unknown) => {
    assert.ok(error instanceof ConnectedAppTransportError);
    assert.equal(error.code, "mcp_upstream_error");
    assert.equal(error.upstreamStatus, 429);
    assert.deepEqual(error.upstream, {
      error: { code: "rate_limited", message: "retry; authorization=[REDACTED]" },
      authorization: "[REDACTED]",
    });
    assert.doesNotMatch(JSON.stringify(error), /super-secret-access-token/);
    return true;
  });
  mode = "redirect";
  await assert.rejects(() => transport.call("tools/list"), (error: unknown) => {
    assert.ok(error instanceof ConnectedAppTransportError);
    assert.equal(error.upstreamStatus, 307);
    assert.equal(error.upstream, "moved");
    return true;
  });
  assert.equal(calls, 2);
});

test("propagates AbortSignal to fetch and cancels the active response reader", async () => {
  let fetchSignal: AbortSignal | null = null;
  let cancelled = false;
  const fetchMock: typeof fetch = async (_input, init) => {
    fetchSignal = init?.signal as AbortSignal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message\ndata: {"jsonrpc":"2.0"'));
      },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
  };
  const transport = new ConnectedAppTransport(credential(), { fetch: fetchMock });
  const controller = new AbortController();
  const pending = transport.call("tools/list", undefined, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new DOMException("client disconnected", "AbortError"));
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.equal(fetchSignal, controller.signal);
  assert.equal(cancelled, true);
});

test("resolves an SSE call at its matching JSON-RPC reply and cancels a still-open body", async () => {
  let cancelled = false;
  const transport = new ConnectedAppTransport(credential(), {
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n',
          'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n',
        ].join("")));
      },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } }),
  });
  const response = await transport.call("tools/list");
  assert.deepEqual(response.messages, [
    { jsonrpc: "2.0", method: "notifications/progress" },
    { jsonrpc: "2.0", id: 1, result: { tools: [] } },
  ]);
  assert.equal(cancelled, true);
});

test("close DELETEs an established session once with auth and the MCP session header", async () => {
  const requests: Request[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request.clone());
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    const body = JSON.parse(await request.text()) as Record<string, unknown>;
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }), {
        headers: { "content-type": "application/json", "mcp-session-id": "session-close" },
      });
    }
    return new Response(null, { status: 202 });
  };
  const transport = new ConnectedAppTransport(credential("Bearer   super-secret-access-token"), { fetch: fetchMock });
  await transport.initialize({ protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Floyd", version: "1" } });
  await transport.close();
  await transport.close();
  const deletes = requests.filter((request) => request.method === "DELETE");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0]!.url, RESOURCE);
  assert.equal(deletes[0]!.headers.get("authorization"), `Bearer ${SECRET}`);
  assert.equal(deletes[0]!.headers.get("mcp-session-id"), "session-close");
  assert.equal(deletes[0]!.headers.get("mcp-protocol-version"), "2025-06-18");
});

test("does not acknowledge a JSON-RPC initialize error", async () => {
  let requests = 0;
  const transport = new ConnectedAppTransport(credential(), {
    fetch: async (_input, init) => {
      requests += 1;
      const request = new Request(RESOURCE, init);
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32602, message: "unsupported protocol" },
      }), { headers: { "content-type": "application/json" } });
    },
  });
  await assert.rejects(() => transport.initialize({ protocolVersion: "2025-06-18" }), (error: unknown) => {
    assert.ok(error instanceof ConnectedAppTransportError);
    assert.equal(error.code, "mcp_initialize_failed");
    assert.deepEqual(error.upstream, { code: -32602, message: "unsupported protocol" });
    return true;
  });
  assert.equal(requests, 1);
});

test("rejects non-Bearer credentials and unsupported non-empty response types without leaking secrets", async () => {
  assert.throws(
    () => new ConnectedAppTransport(credential(`Basic ${SECRET}`)),
    (error: unknown) => error instanceof ConnectedAppTransportError && error.code === "mcp_authorization_invalid",
  );
  const transport = new ConnectedAppTransport(credential(), {
    fetch: async () => new Response(`echo ${SECRET}`, { headers: { "content-type": "text/plain" } }),
  });
  await assert.rejects(() => transport.call("resources/list"), (error: unknown) => {
    assert.ok(error instanceof ConnectedAppTransportError);
    assert.equal(error.code, "mcp_content_type_invalid");
    assert.equal(error.upstream, "echo [REDACTED]");
    assert.doesNotMatch(JSON.stringify(error), /super-secret-access-token/);
    return true;
  });
});
