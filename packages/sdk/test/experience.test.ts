import test from "node:test";
import assert from "node:assert/strict";
import {
  FloydApiError,
  FloydClient,
  FLOYD_EXPERIENCE_VERSION,
  FLOYD_SDK_PROTOCOL_VERSION,
} from "../src/index.ts";
// @ts-expect-error The dependency-free browser artifact intentionally ships as plain JavaScript.
import * as BrowserSdk from "../browser/floyd-sdk.js";

const {
  FloydApiError: BrowserApiError,
  FloydBrowserClient,
  FLOYD_EXPERIENCE_VERSION: BROWSER_EXPERIENCE_VERSION,
  FLOYD_SDK_PROTOCOL_VERSION: BROWSER_PROTOCOL_VERSION,
} = BrowserSdk;

const envelope = {
  id: "primary",
  schema_version: "1.0.0",
  revision: 8,
  active: { project_id: "prj_1", session_id: "ses_1", run_id: "run_1" },
  model_route: {
    provider: "opencode-go",
    model: "kimi",
    base_url: null,
    provider_profile_id: "go",
    credential_ref: "keychain://go",
  },
  transcript_cursor: 41,
  transcript_epoch: "epoch-1",
  last_event_id: "41",
  pending_questions: [],
  pending_permissions: [],
  composer_draft: "continue the migration",
  selected_artifact_id: null,
  selected_view: "editor",
  surfaces: {},
  updated_at: "2026-07-14T12:00:00.000Z",
  updated_by_device_id: "dev_1",
};

test("typed client negotiates with protocol constants and addresses the requested envelope", async () => {
  const seen: Request[] = [];
  const client = new FloydClient({
    token: "core-token",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      seen.push(request.clone());
      if (request.url.endsWith("/negotiate")) {
        return Response.json({
          accepted: true,
          envelope_version: FLOYD_EXPERIENCE_VERSION,
          core_protocol_version: FLOYD_SDK_PROTOCOL_VERSION,
          minimum_sdk_version: "1.0.0",
        });
      }
      return Response.json(envelope);
    },
  });

  const negotiated = await client.negotiateExperience({
    surface_id: "ide/floyd",
    capabilities: ["composer", "artifacts"],
  });
  assert.equal(negotiated.accepted, true);
  assert.deepEqual(JSON.parse(await seen[0]!.text()), {
    surface_id: "ide/floyd",
    sdk_version: FLOYD_SDK_PROTOCOL_VERSION,
    supported_envelope_versions: [FLOYD_EXPERIENCE_VERSION],
    capabilities: ["composer", "artifacts"],
  });
  assert.equal(seen[0]!.method, "POST");
  assert.equal(new URL(seen[0]!.url).pathname, "/api/experience/negotiate");

  await client.experience("team/alpha");
  assert.equal(new URL(seen[1]!.url).pathname, "/api/experience/team%2Falpha");
  assert.equal(seen[1]!.method, "GET");
});

test("typed client sends optimistic revision and preserves exact 409 and 426 payloads", async () => {
  const seen: Request[] = [];
  let responseIndex = 0;
  const responses = [
    new Response(JSON.stringify({
      error: "revision_conflict",
      expected_revision: 7,
      actual_revision: 8,
      envelope,
    }), { status: 409, headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify({
      error: "sdk_upgrade_required",
      minimum_sdk_version: "2.0.0",
      core_protocol_version: "2.0.0",
    }), { status: 426, headers: { "content-type": "application/json" } }),
  ];
  const client = new FloydClient({
    token: "core-token",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      seen.push(request.clone());
      return responses[responseIndex++]!;
    },
  });

  await assert.rejects(
    () => client.updateExperience("primary", { expected_revision: 7, composer_draft: "mine" }),
    (error: unknown) => {
      assert.ok(error instanceof FloydApiError);
      assert.equal(error.status, 409);
      assert.deepEqual(error.payload, {
        error: "revision_conflict",
        expected_revision: 7,
        actual_revision: 8,
        envelope,
      });
      return true;
    },
  );
  assert.equal(seen[0]!.method, "PATCH");
  assert.deepEqual(JSON.parse(await seen[0]!.text()), { expected_revision: 7, composer_draft: "mine" });

  await assert.rejects(
    () => client.negotiateExperience({
      surface_id: "legacy",
      sdk_version: "0.1.0",
      supported_envelope_versions: ["0.1.0"],
      capabilities: [],
    }),
    (error: unknown) => {
      assert.ok(error instanceof FloydApiError);
      assert.equal(error.status, 426);
      assert.deepEqual(error.payload, {
        error: "sdk_upgrade_required",
        minimum_sdk_version: "2.0.0",
        core_protocol_version: "2.0.0",
      });
      return true;
    },
  );
});

test("typed experience watch resumes, parses SSE, and cancels its reader", async () => {
  let request: Request | undefined;
  let cancelled = false;
  const client = new FloydClient({
    token: "core-token",
    fetch: async (input, init) => {
      request = input instanceof Request ? input : new Request(input, init);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            `id: 8\r\nevent: experience\r\ndata: ${JSON.stringify(envelope)}\r\n\r\n`,
          ));
        },
        cancel() { cancelled = true; },
      }), { headers: { "content-type": "text/event-stream" } });
    },
  });

  for await (const event of client.watchExperience("primary", { lastEventId: "7" })) {
    assert.deepEqual(event, { id: "8", type: "experience", data: envelope });
    break;
  }
  assert.equal(request?.headers.get("last-event-id"), "7");
  assert.equal(new URL(request!.url).pathname, "/api/experience/primary/stream");
  assert.equal(cancelled, true);
});

test("typed and browser clients expose the same device and handoff lifecycle", async () => {
  async function exercise(client: FloydClient | InstanceType<typeof FloydBrowserClient>, seen: Request[]) {
    await client.enrollExperienceDevice({ platform: "macos" }, "device/one");
    await client.enrollExperienceDeviceWithScopes({ platform: "ios" }, ["health:read"], "device/two");
    await client.authenticateExperienceDevice("device/one", "secret-value");
    await client.issueExperienceHandoff({ envelope_id: "primary", envelope_revision: 8, ttl_ms: 30_000 });
    await client.consumeExperienceHandoff("hnd_token", "device/one", "device-secret");
    await client.pairExperienceHandoff("hnd_pair_token");
    await client.revokeCurrentDeviceSession();
    await client.revokeExperienceHandoff("handoff/one");
    await client.revokeExperienceDevice("device/one");

    assert.deepEqual(seen.map((request) => [request.method, new URL(request.url).pathname]), [
      ["POST", "/api/devices/enroll"],
      ["POST", "/api/devices/enroll"],
      ["POST", "/api/devices/authenticate"],
      ["POST", "/api/handoffs"],
      ["POST", "/api/handoffs/consume"],
      ["POST", "/api/handoffs/pair"],
      ["DELETE", "/api/device-sessions/current"],
      ["DELETE", "/api/handoffs/handoff%2Fone"],
      ["DELETE", "/api/devices/device%2Fone"],
    ]);
    assert.deepEqual(JSON.parse(await seen[0]!.clone().text()), { metadata: { platform: "macos" }, device_id: "device/one" });
    assert.deepEqual(JSON.parse(await seen[1]!.clone().text()), {
      metadata: { platform: "ios" }, allowed_scopes: ["health:read"], device_id: "device/two",
    });
    assert.deepEqual(JSON.parse(await seen[2]!.clone().text()), { device_id: "device/one", secret: "secret-value" });
    assert.deepEqual(JSON.parse(await seen[4]!.clone().text()), {
      token: "hnd_token",
      device_id: "device/one",
      device_secret: "device-secret",
    });
    assert.deepEqual(JSON.parse(await seen[5]!.clone().text()), { token: "hnd_pair_token" });
  }

  for (const Client of [FloydClient, FloydBrowserClient] as const) {
    const seen: Request[] = [];
    const client = new Client({
      baseUrl: "http://127.0.0.1:41414",
      token: "core-token",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(input instanceof Request ? input.clone() : new Request(input, init));
        return Response.json({ ok: true });
      },
    });
    await exercise(client as FloydClient | InstanceType<typeof FloydBrowserClient>, seen);
  }
});

test("typed and browser clients expose the same connector lifecycle without actor spoofing", async () => {
  for (const Client of [FloydClient, FloydBrowserClient] as const) {
    const seen: Request[] = [];
    const client = new Client({
      baseUrl: "http://127.0.0.1:41414",
      token: "core-token",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        seen.push(request.clone());
        return Response.json({ ok: true });
      },
    }) as FloydClient;
    await client.connectors();
    await client.createConnector({
      id: "user-openai", displayName: "User OpenAI", provider: "openai", baseUrl: "https://api.openai.com/v1",
    });
    await client.storeConnectorApiKey("user/openai", "provider-secret");
    await client.startConnectorOAuth("user/openai", "http://127.0.0.1:7777/callback", 60_000);
    await client.completeConnectorOAuth("oauth-state", "oauth-code");
    await client.revokeConnector("user/openai");

    assert.deepEqual(seen.map((request) => [request.method, new URL(request.url).pathname]), [
      ["GET", "/api/connectors"],
      ["POST", "/api/connectors"],
      ["POST", "/api/connectors/user%2Fopenai/api-key"],
      ["POST", "/api/connectors/user%2Fopenai/oauth/start"],
      ["POST", "/api/connectors/oauth/callback"],
      ["DELETE", "/api/connectors/user%2Fopenai"],
    ]);
    for (const request of seen) assert.equal((await request.text()).includes("actor"), false);
  }
});

test("typed and browser clients expose connected-app discovery, OAuth, invocation, and revocation without callback secrets", async () => {
  for (const Client of [FloydClient, FloydBrowserClient] as const) {
    const seen: Request[] = [];
    const client = new Client({
      baseUrl: "http://127.0.0.1:41414",
      token: "core-token",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        seen.push(request.clone());
        return Response.json({ ok: true });
      },
    }) as FloydClient;
    await client.connectedApps();
    await client.createConnectedApp({ id: "notion", displayName: "Notion", resourceUrl: "https://mcp.notion.com/mcp" });
    await client.startConnectedAppOAuth("notion", 60_000);
    await client.refreshConnectedApp("notion");
    await client.invokeConnectedApp("notion", { method: "tools/list", params: {} });
    await client.revokeConnectedApp("notion");
    assert.deepEqual(seen.map((request) => [request.method, new URL(request.url).pathname]), [
      ["GET", "/api/connected-apps"],
      ["POST", "/api/connected-apps"],
      ["POST", "/api/connected-apps/notion/oauth/start"],
      ["POST", "/api/connected-apps/notion/refresh"],
      ["POST", "/api/connected-apps/notion/invoke"],
      ["DELETE", "/api/connected-apps/notion"],
    ]);
    assert.deepEqual(JSON.parse(await seen[4]!.clone().text()), { method: "tools/list", params: {} });
    assert.equal(seen.some((request) => new URL(request.url).pathname.includes("callback")), false);
    for (const request of seen) assert.equal((await request.text()).includes("actor"), false);
  }
});

test("typed and browser clients preserve run scope for attach and steering", async () => {
  for (const Client of [FloydClient, FloydBrowserClient] as const) {
    const seen: Request[] = [];
    const client = new Client({
      baseUrl: "http://127.0.0.1:41414",
      token: "core-token",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        seen.push(request.clone());
        if (new URL(request.url).pathname.endsWith("/attach")) {
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("event: hello\ndata: {}\n\n"));
              controller.close();
            },
          }), { headers: { "content-type": "text/event-stream" } });
        }
        return Response.json({ accepted: true });
      },
    });
    for await (const _event of client.attachSession("session/one", "tester", { runId: "run/one" })) {
      break;
    }
    await client.steer("session/one", "continue", "tester", undefined, "run/one");
    assert.deepEqual(JSON.parse(await seen[0]!.text()), { actor: "tester", run_id: "run/one" });
    assert.deepEqual(JSON.parse(await seen[1]!.text()), {
      type: "steer", text: "continue", actor: "tester", run_id: "run/one",
    });
  }
});

test("browser client mirrors negotiation, conflict, resume, parsing, and cleanup", async () => {
  assert.equal(BROWSER_EXPERIENCE_VERSION, FLOYD_EXPERIENCE_VERSION);
  assert.equal(BROWSER_PROTOCOL_VERSION, FLOYD_SDK_PROTOCOL_VERSION);
  const seen: Request[] = [];
  let cancelled = false;
  const client = new FloydBrowserClient({
    baseUrl: "http://127.0.0.1:41414",
    token: "browser-token",
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      seen.push(request.clone());
      const path = new URL(request.url).pathname;
      if (path.endsWith("/negotiate")) {
        const body = await request.clone().json() as { sdk_version?: string };
        if (body.sdk_version === "0.1.0") {
          return Response.json({
            error: "sdk_upgrade_required",
            minimum_sdk_version: "2.0.0",
            core_protocol_version: "2.0.0",
          }, { status: 426 });
        }
        return Response.json({
          accepted: true,
          envelope_version: BROWSER_EXPERIENCE_VERSION,
          core_protocol_version: BROWSER_PROTOCOL_VERSION,
          minimum_sdk_version: "1.0.0",
        });
      }
      if (request.method === "PATCH") {
        return Response.json({ error: "revision_conflict", actual_revision: 8 }, { status: 409 });
      }
      if (request.method === "GET" && path === "/api/experience/primary") {
        return Response.json(envelope);
      }
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            `id: 8\nevent: experience\ndata: ${JSON.stringify(envelope)}\n\n`,
          ));
        },
        cancel() { cancelled = true; },
      }), { headers: { "content-type": "text/event-stream" } });
    },
  });

  await client.negotiateExperience({ surface_id: "cockpit", capabilities: ["composer"] });
  assert.deepEqual(JSON.parse(await seen[0]!.text()), {
    surface_id: "cockpit",
    sdk_version: BROWSER_PROTOCOL_VERSION,
    supported_envelope_versions: [BROWSER_EXPERIENCE_VERSION],
    capabilities: ["composer"],
  });
  assert.deepEqual(await client.experience(), envelope);
  assert.equal(new URL(seen[1]!.url).pathname, "/api/experience/primary");
  await assert.rejects(
    () => client.updateExperience("primary", { expected_revision: 7 }),
    (error: unknown) => {
      const apiError = error as { status?: number; payload?: unknown };
      return error instanceof BrowserApiError
        && apiError.status === 409
        && JSON.stringify(apiError.payload) === JSON.stringify({ error: "revision_conflict", actual_revision: 8 });
    },
  );
  assert.deepEqual(JSON.parse(await seen[2]!.text()), { expected_revision: 7 });
  await assert.rejects(
    () => client.negotiateExperience({
      surface_id: "legacy-browser",
      sdk_version: "0.1.0",
      supported_envelope_versions: ["0.1.0"],
      capabilities: [],
    }),
    (error: unknown) => {
      const apiError = error as { status?: number; payload?: unknown };
      return error instanceof BrowserApiError
        && apiError.status === 426
        && JSON.stringify(apiError.payload) === JSON.stringify({
          error: "sdk_upgrade_required",
          minimum_sdk_version: "2.0.0",
          core_protocol_version: "2.0.0",
        });
    },
  );
  for await (const event of client.watchExperience("primary", { lastEventId: "7" })) {
    assert.deepEqual(event, { id: "8", type: "experience", data: envelope });
    break;
  }
  assert.equal(seen[4]!.headers.get("last-event-id"), "7");
  assert.equal(cancelled, true);
});
