import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeSdkRuntime } from "../src/index.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("official SDK adapter uses pinned v2 lifecycle routes and payloads", async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = request.method === "GET" ? undefined : JSON.parse(await request.text() || "null") as unknown;
    requests.push({ url: request.url, method: request.method, body });
    const path = new URL(request.url).pathname;
    if (path === "/api/health") return json({ healthy: true });
    if (path === "/api/session" && request.method === "POST") {
      return json({ data: { id: "ses_sdk_1" } });
    }
    if (path.endsWith("/message")) {
      return json({ data: [{ id: "msg_1", type: "assistant", time: { created: 1, completed: 2 }, content: [] }], cursor: {} });
    }
    if (path.endsWith("/permission") && request.method === "GET") return json({ data: [{ id: "per_1" }] });
    if (path.endsWith("/question") && request.method === "GET") return json({ data: [{ id: "que_1" }] });
    return new Response(null, { status: 204 });
  };
  const runtime = new OpenCodeSdkRuntime({ baseUrl: "http://127.0.0.1:9999/", fetch: fetchMock });

  assert.equal(await runtime.health(), true);
  assert.equal(await runtime.createSession("/work", "provider", "model", "build"), "ses_sdk_1");
  await runtime.prompt("ses_sdk_1", "build it");
  await runtime.steer("ses_sdk_1", "avoid generated files");
  await runtime.switchModel("ses_sdk_1", "provider-2", "model-2");
  await runtime.abortSession("ses_sdk_1");
  assert.equal((await runtime.messages("ses_sdk_1")).length, 1);
  assert.deepEqual(await runtime.pendingPermissions("ses_sdk_1"), [{ id: "per_1" }]);
  await runtime.replyPermission("ses_sdk_1", "per_1", "once");
  assert.deepEqual(await runtime.pendingQuestions("ses_sdk_1"), [{ id: "que_1" }]);
  await runtime.replyQuestion("ses_sdk_1", "que_1", [["Yes"]]);

  assert.deepEqual(requests.map((request) => [new URL(request.url).pathname, request.method]), [
    ["/api/health", "GET"],
    ["/api/session", "POST"],
    ["/api/session/ses_sdk_1/prompt", "POST"],
    ["/api/session/ses_sdk_1/prompt", "POST"],
    ["/api/session/ses_sdk_1/model", "POST"],
    ["/session/ses_sdk_1/abort", "POST"],
    ["/api/session/ses_sdk_1/message", "GET"],
    ["/api/session/ses_sdk_1/permission", "GET"],
    ["/api/session/ses_sdk_1/permission/per_1/reply", "POST"],
    ["/api/session/ses_sdk_1/question", "GET"],
    ["/api/session/ses_sdk_1/question/que_1/reply", "POST"],
  ]);
  assert.deepEqual(requests[1]?.body, {
    agent: "build",
    location: { directory: "/work" },
    model: { providerID: "provider", id: "model" },
  });
  assert.deepEqual(requests[2]?.body, {
    delivery: "queue",
    prompt: { text: "build it" },
    resume: true,
  });
  assert.deepEqual(requests[3]?.body, {
    delivery: "steer",
    prompt: { text: "avoid generated files" },
    resume: true,
  });
  const messagesRequest = requests.find((request) => new URL(request.url).pathname.endsWith("/message"));
  assert.equal(new URL(messagesRequest?.url ?? "http://invalid").searchParams.get("limit"), "200");
});

test("event subscription aborts the SDK reader when stopped", async () => {
  let aborted = false;
  const encoder = new TextEncoder();
  const fetchMock: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    request.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"session.test","data":{"sessionID":"ses_1"}}\n\n'));
      },
    }), { headers: { "content-type": "text/event-stream" } });
  };
  const runtime = new OpenCodeSdkRuntime({ baseUrl: "http://127.0.0.1:9999", fetch: fetchMock, reconnectDelayMs: 1 });
  const seen = new Promise<unknown>((resolve) => {
    const subscription = runtime.subscribeEvents((event) => {
      subscription.stop();
      resolve(event);
    });
  });
  assert.deepEqual(await seen, { type: "session.test", data: { sessionID: "ses_1" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(aborted, true);
});
