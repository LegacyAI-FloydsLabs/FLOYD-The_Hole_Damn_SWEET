import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { createVaultMcpRouter } from "../server/vault-mcp-router.mjs";

const REAL_DESTINATION = "https://remote.example.test/private-mcp?tenant=secret";
const REAL_AUTHORIZATION = "Bearer real-mcp-secret";
const observations = [];
let router;

before(async () => {
  router = createVaultMcpRouter({
    resolveTarget: async ({ id, app }) => {
      if (id !== "private-search") return null;
      if (app !== "cursem") {
        throw Object.assign(new Error("denied"), {
          status: 403,
          publicMessage: "This application cannot use the requested Vault MCP target.",
        });
      }
      // In production this object is returned by the Keychain-backed Vault
      // authority; it never exists in CURSEM configuration or environment.
      return {
        url: REAL_DESTINATION,
        headers: { authorization: REAL_AUTHORIZATION, "x-tenant-secret": "real-tenant-secret" },
      };
    },
    fetchImpl: async (url, init) => {
      observations.push({ url, init });
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: "response",
        result: { tools: [{ name: "remote-search" }] },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "remote-session",
          location: "https://remote.example.test/secret-location",
        },
      });
    },
  });
});

describe("Vault MCP router", () => {
  it("keeps the app on loopback+fv while Vault injects the remote destination and credential", async () => {
    const req = {
      method: "POST",
      headers: {
        authorization: "Bearer fv_cursem_test",
        "content-type": "application/json",
        "mcp-session-id": "app-session",
        "x-api-key": "must-not-pass",
      },
    };
    const res = captureResponse();
    const handled = await router.handle({
      req,
      res,
      requestUrl: new URL("http://127.0.0.1:13031/mcp/private-search"),
      body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: "request", method: "tools/list", params: {} })),
      app: "cursem",
    });
    assert.equal(handled, true);
    assert.equal(res.status, 200);
    assert.equal(res.headers["mcp-session-id"], "remote-session");
    assert.equal(res.headers.location, undefined);
    assert.deepEqual(JSON.parse(Buffer.concat(res.chunks).toString("utf8")), {
      jsonrpc: "2.0",
      id: "response",
      result: { tools: [{ name: "remote-search" }] },
    });
    const observed = observations.at(-1);
    assert.equal(observed.url, REAL_DESTINATION);
    assert.equal(observed.init.method, "POST");
    assert.equal(observed.init.headers.authorization, REAL_AUTHORIZATION);
    assert.equal(observed.init.headers["x-tenant-secret"], "real-tenant-secret");
    assert.equal(observed.init.headers["x-api-key"], undefined);
    assert.equal(observed.init.redirect, "manual");
  });

  it("preserves Streamable HTTP GET and DELETE transport semantics", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = captureResponse();
      const handled = await router.handle({
        req: {
          method,
          headers: {
            authorization: "Bearer fv_cursem_test",
            accept: "text/event-stream",
            "mcp-session-id": "app-session",
          },
        },
        res,
        requestUrl: new URL("http://127.0.0.1:13031/mcp/private-search"),
        body: null,
        app: "cursem",
      });
      assert.equal(handled, true);
      assert.equal(res.status, 200);
      const observed = observations.at(-1);
      assert.equal(observed.init.method, method);
      assert.equal(observed.init.body, undefined);
      assert.equal(observed.init.headers["mcp-session-id"], "app-session");
      assert.equal(observed.init.headers.authorization, REAL_AUTHORIZATION);
    }
  });

  it("enforces per-application target access without exposing target details", async () => {
    const res = captureResponse();
    const handled = await router.handle({
      req: {
        method: "POST",
        headers: { authorization: "Bearer fv_other_test", "content-type": "application/json" },
      },
      res,
      requestUrl: new URL("http://127.0.0.1:13031/mcp/private-search"),
      body: Buffer.from("{}"),
      app: "untrusted",
    });
    assert.equal(handled, true);
    assert.equal(res.status, 403);
    const body = Buffer.concat(res.chunks).toString("utf8");
    assert.doesNotMatch(body, /remote\.example|real-mcp-secret|tenant=secret/);
  });

  it("redacts target credentials echoed in headers and across streamed chunk boundaries", async () => {
    const echo = createVaultMcpRouter({
      resolveTarget: async () => ({
        url: REAL_DESTINATION,
        headers: { authorization: REAL_AUTHORIZATION },
      }),
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from(`data: ${REAL_AUTHORIZATION.slice(0, 10)}`));
          controller.enqueue(Buffer.from(`${REAL_AUTHORIZATION.slice(10)}\n\n`));
          controller.close();
        },
      }), {
        headers: {
          "content-type": `text/event-stream; reflected=${REAL_AUTHORIZATION}`,
        },
      }),
    });
    const res = captureResponse();
    await echo.handle({
      req: { method: "GET", headers: {} },
      res,
      requestUrl: new URL("http://127.0.0.1:13031/mcp/private-search"),
      body: null,
      app: "cursem",
    });
    assert.doesNotMatch(res.headers["content-type"], /real-mcp-secret/);
    const body = Buffer.concat(res.chunks).toString("utf8");
    assert.doesNotMatch(body, /real-mcp-secret/);
    assert.match(body, /FLOYD_VAULT_REDACTED/);
  });
});

function captureResponse() {
  return {
    status: null,
    headers: {},
    chunks: [],
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
      );
    },
    write(chunk) {
      this.chunks.push(Buffer.from(chunk));
    },
    end(chunk) {
      if (chunk !== undefined) this.write(chunk);
    },
  };
}
