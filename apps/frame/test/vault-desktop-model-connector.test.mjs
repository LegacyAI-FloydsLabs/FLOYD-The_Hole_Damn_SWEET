import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Anthropic from "../../../intake/surfaces/desktop/node_modules/@anthropic-ai/sdk/index.mjs";
import {
  ConnectorAuthorityError,
  ConnectorAuthorityService,
} from "../server/model-connector-authority.ts";
import { createModelConnectorVault } from "../server/model-connector-vault.mjs";
import { createVaultProxy } from "../server/vault-proxy.mjs";

const REAL_KEY = "connector-real-secret-123456";

test("Desktop selects and invokes a redacted Vault connector with its fv_ capability", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const payload = JSON.parse(String(init.body || "{}"));
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init.headers)),
      body: payload,
    });
    if (payload.stream) {
      const split = Math.floor(REAL_KEY.length / 2);
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"before ${REAL_KEY.slice(0, split)}`,
          ));
          controller.enqueue(new TextEncoder().encode(
            `${REAL_KEY.slice(split)} after"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
          ));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "content-length": "999",
          "x-provider-debug": `echo=${REAL_KEY}`,
          "request-id": `id-${REAL_KEY}`,
        },
      });
    }
    return Response.json({
      id: "msg_vault",
      type: "message",
      role: "assistant",
      model: payload.model,
      content: [{ type: "text", text: "connector works" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 2 },
    });
  };
  const connectorVault = createModelConnectorVault({
    secretsDir: mkdtempSync(join(tmpdir(), "desktop-model-connector-")),
    masterKey: Buffer.alloc(32, 21),
    returnUrl: "http://127.0.0.1:13030/?settings=connections",
    fetchImpl,
  });
  await createConnector(connectorVault, {
    id: "private-anthropic",
    displayName: "Private Anthropic",
    provider: "anthropic",
    baseUrl: "https://private-provider.invalid/v1",
  }, REAL_KEY);

  const proxy = createVaultProxy({
    secretsDir: mkdtempSync(join(tmpdir(), "desktop-model-proxy-")),
    realKey: () => null,
    upstreams: {},
    modelConnectors: connectorVault,
    port: 0,
  });
  const address = await proxy.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const desktopToken = proxy.store.issue("desktop");
  try {
    const catalog = await fetch(`${baseUrl}/connectors/catalog`, {
      headers: { authorization: `Bearer ${desktopToken}` },
    });
    assert.equal(catalog.status, 200);
    const catalogText = await catalog.text();
    assert.deepEqual(JSON.parse(catalogText), {
      connectors: [{
        id: "private-anthropic",
        displayName: "Private Anthropic",
        dialect: "anthropic",
        configured: true,
      }],
    });
    assert.doesNotMatch(catalogText, /private-provider|credentialRef|connector-real-secret/);

    const mutation = await fetch(`${baseUrl}/connectors`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${desktopToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "forbidden",
        displayName: "Forbidden",
        provider: "anthropic",
        baseUrl: "https://forbidden.invalid",
      }),
    });
    assert.equal(mutation.status, 403);
    assert.match(await mutation.text(), /connector_scope_denied/);

    const client = new Anthropic({
      apiKey: desktopToken,
      baseURL: `${baseUrl}/connectors/private-anthropic/invoke`,
    });
    const message = await client.messages.create({
      model: "custom-claude",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(message.content[0]?.type, "text");
    assert.equal(message.content[0]?.text, "connector works");
    assert.equal(calls[0].url, "https://private-provider.invalid/v1/messages");
    assert.equal(calls[0].headers["x-api-key"], REAL_KEY);
    assert.doesNotMatch(JSON.stringify(calls[0]), /fv_desktop_/);

    const streamed = await fetch(`${baseUrl}/connectors/private-anthropic/invoke/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": desktopToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "custom-claude",
        max_tokens: 32,
        messages: [{ role: "user", content: "echo test" }],
        stream: true,
      }),
    });
    assert.equal(streamed.status, 200);
    assert.equal(streamed.headers.get("x-provider-debug"), null);
    assert.equal(streamed.headers.get("request-id"), "id-[FLOYD_VAULT_REDACTED]");
    assert.equal(streamed.headers.get("content-length"), null);
    const streamedText = await streamed.text();
    assert.doesNotMatch(streamedText, new RegExp(REAL_KEY));
    assert.match(streamedText, /before \[FLOYD_VAULT_REDACTED\] after/);
    assert.match(streamedText, /event: message_stop/);
  } finally {
    await proxy.close();
  }
});

test("OAuth upstream error payload redacts authorization code, verifier, and client secret", async () => {
  let submittedVerifier = "";
  let submittedAuthorization = "";
  const clientSecret = "oauth-client-secret-654321";
  const authority = new ConnectorAuthorityService(new DatabaseSync(":memory:"), {
    masterKey: Buffer.alloc(32, 22),
    fetch: async (_input, init = {}) => {
      const form = init.body;
      assert.ok(form instanceof URLSearchParams);
      submittedVerifier = form.get("code_verifier") || "";
      submittedAuthorization = new Headers(init.headers).get("authorization") || "";
      const echoed = JSON.stringify({
        error: "invalid_grant",
        code: form.get("code"),
        verifier: submittedVerifier,
        clientSecret,
        authorization: submittedAuthorization,
      });
      const splitAt = echoed.indexOf(clientSecret) + Math.floor(clientSecret.length / 2);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(echoed.slice(0, splitAt)));
          controller.enqueue(new TextEncoder().encode(echoed.slice(splitAt)));
          controller.close();
        },
      }), { status: 400, headers: { "content-type": "application/json" } });
    },
  });
  authority.createProfile({
    id: "oauth-anthropic",
    displayName: "OAuth Anthropic",
    provider: "anthropic",
    baseUrl: "https://private-provider.invalid/v1",
    clientId: "desktop-client",
    clientSecret,
    clientAuth: "client_secret_basic",
    authorizationUrl: "https://auth.private.invalid/authorize",
    tokenUrl: "https://auth.private.invalid/token",
  });
  const started = authority.beginOAuth(
    "oauth-anthropic",
    "http://127.0.0.1:13031/connectors/oauth/callback",
  );
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  assert.ok(state);
  const authorizationCode = "oauth-code-secret-123456";

  await assert.rejects(
    authority.completeOAuth(state, authorizationCode),
    (error) => {
      assert.ok(error instanceof ConnectorAuthorityError);
      assert.equal(error.httpStatus, 400);
      const response = JSON.stringify(error.upstream);
      for (const secret of [authorizationCode, submittedVerifier, clientSecret, submittedAuthorization]) {
        assert.ok(secret);
        assert.doesNotMatch(response, new RegExp(escapeRegex(secret)));
      }
      assert.match(response, /\[FLOYD_VAULT_REDACTED\]/);
      return true;
    },
  );
});

async function createConnector(vault, profile, secret) {
  const created = await vault.dispatch({
    app: "core",
    method: "POST",
    pathname: "/connectors",
    body: profile,
  });
  assert.equal(created.status, 201);
  const ingress = vault.ingressKey("core").body;
  const publicKey = await globalThis.crypto.subtle.importKey(
    "spki",
    Buffer.from(ingress.spki, "base64url"),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const dataKey = await globalThis.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"],
  );
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertextAndTag = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    dataKey,
    new TextEncoder().encode(secret),
  ));
  const wrappedKey = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    await globalThis.crypto.subtle.exportKey("raw", dataKey),
  ));
  const encoded = (value) => Buffer.from(value).toString("base64url");
  const stored = await vault.dispatch({
    app: "core",
    method: "POST",
    pathname: `/connectors/${encodeURIComponent(profile.id)}/api-key`,
    body: {
      sealedApiKey: {
        keyId: ingress.keyId,
        wrappedKey: encoded(wrappedKey),
        iv: encoded(iv),
        ciphertext: encoded(ciphertextAndTag.subarray(0, -16)),
        tag: encoded(ciphertextAndTag.subarray(-16)),
      },
    },
  });
  assert.equal(stored.status, 201);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
