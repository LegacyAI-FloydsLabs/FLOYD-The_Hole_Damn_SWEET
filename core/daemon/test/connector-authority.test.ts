import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConnectorAuthorityError,
  ConnectorAuthorityService,
  type ConnectorAuthorityEvent,
} from "../src/connector-authority.ts";

function fixture(fetch?: typeof globalThis.fetch) {
  const root = mkdtempSync(join(tmpdir(), "floyd-connectors-"));
  const db = new DatabaseSync(":memory:");
  let now = Date.parse("2026-07-14T12:00:00.000Z");
  const events: ConnectorAuthorityEvent[] = [];
  const service = new ConnectorAuthorityService(db, {
    masterKeyPath: join(root, "connector.key"),
    now: () => now,
    fetch,
    evidence: (event) => events.push(event),
  });
  return { db, service, events, advance: (ms: number) => (now += ms) };
}

test("API key connectors encrypt secrets, bind provider endpoints, and expose only references", async () => {
  const { db, service, events } = fixture();
  const profile = service.createProfile({
    id: "anthropic-main",
    displayName: "Anthropic main",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
  });
  assert.equal(profile.credentialRef, null);
  const credentialRef = service.storeApiKey(profile.id, "anthropic-secret-value");
  assert.equal(credentialRef, "floyd-connector:anthropic-main");
  const stored = db.prepare(`SELECT * FROM connector_credentials`).get() as Record<string, unknown>;
  assert.equal(JSON.stringify(stored).includes("anthropic-secret-value"), false);
  assert.equal(JSON.stringify(service.profiles()).includes("anthropic-secret-value"), false);
  assert.equal(events.some((event) => JSON.stringify(event).includes("anthropic-secret-value")), false);

  const resolved = await service.resolve(credentialRef);
  assert.equal(resolved.apiKey, "anthropic-secret-value");
  assert.equal(resolved.authorization, undefined);
  assert.equal(resolved.baseUrl, "https://api.anthropic.com/v1");
  assert.equal(resolved.provider, "anthropic");
  assert.throws(() => service.createProfile({
    id: "bad-http",
    displayName: "Bad",
    provider: "openai",
    baseUrl: "http://attacker.example/v1",
  }), (error: unknown) => {
    assert.equal((error as ConnectorAuthorityError).code, "invalid_input");
    return true;
  });
});

test("OAuth uses PKCE, hashes state, encrypts tokens, coalesces refresh, and revokes", async () => {
  let authorizationExchanges = 0;
  let refreshExchanges = 0;
  let revocations = 0;
  let seenVerifier = "";
  const mockFetch: typeof globalThis.fetch = async (_input, init) => {
    const form = init?.body as URLSearchParams;
    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
      authorizationExchanges += 1;
      seenVerifier = form.get("code_verifier") ?? "";
      return Response.json({ access_token: "oauth-access-one", refresh_token: "oauth-refresh-one", token_type: "Bearer", expires_in: 120 });
    }
    if (grant === "refresh_token") {
      refreshExchanges += 1;
      assert.equal(form.get("refresh_token"), "oauth-refresh-one");
      return Response.json({ access_token: "oauth-access-two", refresh_token: "oauth-refresh-two", token_type: "Bearer", expires_in: 600 });
    }
    revocations += 1;
    assert.equal(["oauth-access-two", "oauth-refresh-two"].includes(form.get("token") ?? ""), true);
    return new Response(null, { status: 204 });
  };
  const { db, service, events, advance } = fixture(mockFetch);
  service.createProfile({
    id: "openai-oauth",
    displayName: "OpenAI OAuth",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    clientId: "client-id",
    authorizationUrl: "https://identity.example/authorize",
    tokenUrl: "https://identity.example/token",
    revocationUrl: "https://identity.example/revoke",
    scopes: ["models.read", "responses.write"],
  });
  const started = service.beginOAuth("openai-oauth", "http://127.0.0.1:7777/callback");
  const authorizationUrl = new URL(started.authorizationUrl);
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorizationUrl.searchParams.get("state"), started.state);
  assert.equal(authorizationUrl.searchParams.get("scope"), "models.read responses.write");
  const attempt = db.prepare(`SELECT * FROM connector_oauth_attempts`).get() as Record<string, unknown>;
  assert.equal(JSON.stringify(attempt).includes(started.state), false);

  const ref = await service.completeOAuth(started.state, "authorization-code");
  assert.equal(ref, "floyd-connector:openai-oauth");
  assert.equal(authorizationExchanges, 1);
  assert.match(seenVerifier, /^[A-Za-z0-9_-]{43}$/);
  const credential = db.prepare(`SELECT * FROM connector_credentials`).get() as Record<string, unknown>;
  const serialized = JSON.stringify(credential);
  for (const secret of ["oauth-access-one", "oauth-refresh-one", "oauth-access-two", "oauth-refresh-two"]) {
    assert.equal(serialized.includes(secret), false);
    assert.equal(events.some((event) => JSON.stringify(event).includes(secret)), false);
  }

  assert.equal((await service.resolve(ref)).authorization, "Bearer oauth-access-one");
  advance(61_000);
  const resolved = await Promise.all(Array.from({ length: 12 }, () => service.resolve(ref)));
  assert.equal(refreshExchanges, 1);
  assert.equal(resolved.every((item) => item.authorization === "Bearer oauth-access-two"), true);
  const revoked = await service.revoke("openai-oauth");
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.upstreamStatus, 204);
  assert.equal(revocations, 2);
  assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM connector_credentials`).get() as { count: number }).count, 0);
  await assert.rejects(service.resolve(ref), (error: unknown) => {
    assert.equal((error as ConnectorAuthorityError).code, "credential_revoked");
    return true;
  });
});

test("connector mutations roll back when durable evidence fails", () => {
  const root = mkdtempSync(join(tmpdir(), "floyd-connector-evidence-"));
  const db = new DatabaseSync(":memory:");
  const service = new ConnectorAuthorityService(db, {
    masterKeyPath: join(root, "connector.key"),
    evidence: () => { throw new Error("evidence unavailable"); },
  });
  assert.throws(() => service.createProfile({
    id: "rollback",
    displayName: "Rollback",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
  }), /evidence unavailable/);
  assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM connector_profiles`).get() as { count: number }).count, 0);
});

test("OAuth callback claims state before exchange and releases it after upstream failure", async () => {
  let releaseExchange!: () => void;
  let exchangeStarted!: () => void;
  const started = new Promise<void>((resolve) => { exchangeStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseExchange = resolve; });
  let calls = 0;
  const mockFetch: typeof globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      exchangeStarted();
      await release;
      return Response.json({ error: "temporarily unavailable" }, { status: 503 });
    }
    return Response.json({ access_token: "retry-access-token", token_type: "Bearer", expires_in: 300 });
  };
  const { service } = fixture(mockFetch);
  service.createProfile({
    id: "oauth-claim",
    displayName: "OAuth claim",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    clientId: "client-id",
    authorizationUrl: "https://identity.example/authorize",
    tokenUrl: "https://identity.example/token",
  });
  const authorization = service.beginOAuth("oauth-claim", "http://127.0.0.1:7777/callback");
  const first = service.completeOAuth(authorization.state, "authorization-code");
  await started;
  await assert.rejects(
    service.completeOAuth(authorization.state, "authorization-code"),
    (error: unknown) => (error as ConnectorAuthorityError).code === "oauth_state_in_use",
  );
  assert.equal(calls, 1);
  releaseExchange();
  await assert.rejects(first, (error: unknown) => {
    const authorityError = error as ConnectorAuthorityError;
    assert.equal(authorityError.httpStatus, 503);
    assert.deepEqual(authorityError.upstream, { error: "temporarily unavailable" });
    return true;
  });
  assert.equal(await service.completeOAuth(authorization.state, "authorization-code"), "floyd-connector:oauth-claim");
  assert.equal(calls, 2);
});

test("provider header secrets reject control characters before storage", () => {
  const { service } = fixture();
  service.createProfile({
    id: "header-safety",
    displayName: "Header safety",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
  });
  assert.throws(() => service.storeApiKey("header-safety", "malicious\r\nheader"), (error: unknown) => {
    assert.equal((error as ConnectorAuthorityError).code, "secret_invalid");
    return true;
  });
});

test("SQLite refresh claim coalesces rotating tokens across authority instances", async () => {
  const root = mkdtempSync(join(tmpdir(), "floyd-connector-cross-instance-"));
  const db = new DatabaseSync(":memory:");
  let now = Date.parse("2026-07-14T12:00:00.000Z");
  let refreshCalls = 0;
  const fetchMock: typeof globalThis.fetch = async (_input, init) => {
    const grant = (init?.body as URLSearchParams).get("grant_type");
    if (grant === "authorization_code") {
      return Response.json({ access_token: "initial-access", refresh_token: "initial-refresh", expires_in: 120 });
    }
    refreshCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 600 });
  };
  const options = { masterKeyPath: join(root, "connector.key"), now: () => now, fetch: fetchMock };
  const first = new ConnectorAuthorityService(db, options);
  first.createProfile({
    id: "cross-instance",
    displayName: "Cross instance",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    clientId: "client-id",
    authorizationUrl: "https://identity.example/authorize",
    tokenUrl: "https://identity.example/token",
  });
  const authorization = first.beginOAuth("cross-instance", "http://127.0.0.1:7777/callback");
  const ref = await first.completeOAuth(authorization.state, "authorization-code");
  const second = new ConnectorAuthorityService(db, options);
  now += 61_000;
  const results = await Promise.all([first.resolve(ref), second.resolve(ref)]);
  assert.equal(refreshCalls, 1);
  assert.deepEqual(results.map((result) => result.authorization), ["Bearer rotated-access", "Bearer rotated-access"]);
});

test("revoked connectors cannot restart OAuth and Anthropic OAuth remains bearer-authenticated", async () => {
  const fetchMock: typeof globalThis.fetch = async (_input, init) => {
    const form = init?.body as URLSearchParams;
    if (form.has("grant_type")) return Response.json({ access_token: "anthropic-oauth-access", token_type: "Bearer", expires_in: 600 });
    return new Response(null, { status: 204 });
  };
  const { service } = fixture(fetchMock);
  service.createProfile({
    id: "anthropic-oauth",
    displayName: "Anthropic OAuth",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    clientId: "client-id",
    authorizationUrl: "https://identity.example/authorize",
    tokenUrl: "https://identity.example/token",
  });
  const authorization = service.beginOAuth("anthropic-oauth", "http://127.0.0.1:7777/callback");
  const ref = await service.completeOAuth(authorization.state, "authorization-code");
  const resolved = await service.resolve(ref);
  assert.equal(resolved.authorization, "Bearer anthropic-oauth-access");
  assert.equal(resolved.apiKey, undefined);
  await service.revoke("anthropic-oauth");
  assert.throws(() => service.beginOAuth("anthropic-oauth", "http://127.0.0.1:7777/callback"), (error: unknown) => {
    assert.equal((error as ConnectorAuthorityError).code, "connector_revoked");
    return true;
  });
});

test("external token issuance survives evidence sink failure through the durable outbox", async () => {
  const root = mkdtempSync(join(tmpdir(), "floyd-connector-outbox-"));
  const db = new DatabaseSync(":memory:");
  let failEvidence = false;
  const service = new ConnectorAuthorityService(db, {
    masterKeyPath: join(root, "connector.key"),
    fetch: async () => Response.json({ access_token: "outbox-access-token", refresh_token: "outbox-refresh-token", expires_in: 600 }),
    evidence: () => { if (failEvidence) throw new Error("evidence sink unavailable"); },
  });
  service.createProfile({
    id: "outbox-oauth",
    displayName: "Outbox OAuth",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    clientId: "client-id",
    authorizationUrl: "https://identity.example/authorize",
    tokenUrl: "https://identity.example/token",
  });
  const authorization = service.beginOAuth("outbox-oauth", "http://127.0.0.1:7777/callback");
  failEvidence = true;
  const ref = await service.completeOAuth(authorization.state, "authorization-code");
  assert.equal((await service.resolve(ref)).authorization, "Bearer outbox-access-token");
  const outbox = db.prepare(`SELECT event_type, payload_json FROM connector_evidence_outbox`).get() as { event_type: string; payload_json: string };
  assert.equal(outbox.event_type, "connector.oauth.completed");
  assert.equal(outbox.payload_json.includes("outbox-access-token"), false);
  assert.equal(outbox.payload_json.includes("outbox-refresh-token"), false);
  failEvidence = false;
  assert.equal(service.flushEvidenceOutbox(), 1);
  assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM connector_evidence_outbox`).get() as { count: number }).count, 0);
});
