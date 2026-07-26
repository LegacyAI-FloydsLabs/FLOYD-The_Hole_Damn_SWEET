import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConnectedAppAuthorityError,
  ConnectedAppAuthorityService,
  type ConnectedAppAuthorityEvent,
} from "../src/connected-app-authority.ts";

const RESOURCE = "https://mcp.example/mcp";
const RESOURCE_METADATA = "https://mcp.example/.well-known/oauth-protected-resource/mcp";
const ISSUER = "https://auth.example";

function oauthFixture(overrides: {
  resource?: string;
  issuer?: string;
  tokenError?: { status: number; body: unknown };
} = {}) {
  const calls: Array<{ url: string; method: string; form?: URLSearchParams; body?: unknown }> = [];
  const revocationHints: string[] = [];
  let accessVersion = 0;
  const fetchMock: typeof globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const form = init.body instanceof URLSearchParams ? init.body : undefined;
    let body: unknown;
    if (typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ url, method, form: form ? new URLSearchParams(form) : undefined, body });
    if (url === RESOURCE && method === "GET") {
      return new Response('{"error":"invalid_token"}', {
        status: 401,
        headers: { "www-authenticate": `Bearer resource_metadata="${RESOURCE_METADATA}"` },
      });
    }
    if (url === RESOURCE_METADATA) {
      return Response.json({ resource: overrides.resource ?? RESOURCE, authorization_servers: [ISSUER] });
    }
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return Response.json({
        issuer: overrides.issuer ?? ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        registration_endpoint: `${ISSUER}/register`,
        revocation_endpoint: `${ISSUER}/revoke`,
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["notes.read", "notes.write"],
      });
    }
    if (url === `${ISSUER}/register`) {
      assert.deepEqual(body, {
        client_name: "Floyd Workstation",
        redirect_uris: ["http://127.0.0.1:41414/api/connected-apps/oauth/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "notes.read notes.write",
      });
      return Response.json({ client_id: "dynamic-client" }, { status: 201 });
    }
    if (url === `${ISSUER}/token`) {
      if (overrides.tokenError) return Response.json(overrides.tokenError.body, { status: overrides.tokenError.status });
      if (form?.get("grant_type") === "authorization_code") {
        accessVersion = 1;
        return Response.json({
          access_token: "connected-access-one",
          refresh_token: "connected-refresh-one",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "notes.read notes.write",
        });
      }
      if (form?.get("grant_type") === "refresh_token") {
        accessVersion += 1;
        return Response.json({
          access_token: `connected-access-${accessVersion}`,
          refresh_token: `connected-refresh-${accessVersion}`,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "notes.read notes.write",
        });
      }
    }
    if (url === `${ISSUER}/revoke`) {
      revocationHints.push(form?.get("token_type_hint") ?? "");
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };
  const root = mkdtempSync(join(tmpdir(), "floyd-connected-apps-"));
  const db = new DatabaseSync(":memory:");
  const events: ConnectedAppAuthorityEvent[] = [];
  const service = new ConnectedAppAuthorityService(db, {
    masterKeyPath: join(root, "connected-app.key"),
    fetch: fetchMock,
    evidence: (event) => events.push(event),
  });
  return { db, service, calls, events, revocationHints };
}

test("connected app authority discovers, registers, authorizes, refreshes, and revokes without exposing tokens", async () => {
  const { db, service, calls, events, revocationHints } = oauthFixture();
  const discovered = await service.createProfile({
    id: "notes",
    displayName: "Notes",
    resourceUrl: RESOURCE,
    scopes: ["notes.write", "notes.read"],
  });
  assert.equal(discovered.resourceMetadataUrl, RESOURCE_METADATA);
  assert.equal(discovered.issuer, ISSUER);
  assert.equal(discovered.status, "discovered");
  assert.deepEqual(discovered.scopesRequested, ["notes.read", "notes.write"]);

  const started = await service.beginOAuth("notes", "http://127.0.0.1:41414/api/connected-apps/oauth/callback");
  const authorization = new URL(started.authorizationUrl);
  assert.equal(started.connectedAppId, "notes");
  assert.equal(authorization.searchParams.get("resource"), RESOURCE);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.get("scope"), "notes.read notes.write");
  const state = authorization.searchParams.get("state")!;
  const attempt = db.prepare("SELECT * FROM connected_app_oauth_attempts").get() as Record<string, unknown>;
  assert.equal(JSON.stringify(attempt).includes(state), false);

  const credentialRef = await service.completeOAuth(state, "authorization-code");
  assert.equal(credentialRef, "floyd-connected-app:notes");
  const exchange = calls.find((call) => call.form?.get("grant_type") === "authorization_code")!;
  assert.equal(exchange.form!.get("resource"), RESOURCE);
  assert.match(exchange.form!.get("code_verifier") ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.equal(service.profile("notes")!.status, "connected");
  assert.deepEqual(service.profile("notes")!.scopesGranted, ["notes.read", "notes.write"]);
  await assert.rejects(service.completeOAuth(state, "authorization-code"), (error: unknown) => {
    assert.equal((error as ConnectedAppAuthorityError).code, "oauth_state_invalid");
    return true;
  });

  const refreshed = await Promise.all(Array.from({ length: 12 }, () => service.refreshNow("notes")));
  assert.equal(calls.filter((call) => call.form?.get("grant_type") === "refresh_token").length, 1);
  assert.equal(refreshed.every((item) => item.connectedAppId === "notes"), true);
  const refresh = calls.find((call) => call.form?.get("grant_type") === "refresh_token")!;
  assert.equal(refresh.form!.get("resource"), RESOURCE);
  assert.equal(refresh.form!.get("refresh_token"), "connected-refresh-one");

  const serialized = JSON.stringify({
    profiles: db.prepare("SELECT * FROM connected_app_profiles").all(),
    credentials: db.prepare("SELECT * FROM connected_app_credentials").all(),
    attempts: db.prepare("SELECT * FROM connected_app_oauth_attempts").all(),
    events,
  });
  for (const secret of ["connected-access-one", "connected-refresh-one", "connected-access-2", "connected-refresh-2", state]) {
    assert.equal(serialized.includes(secret), false);
  }

  const revoked = await service.revoke("notes");
  assert.deepEqual(revocationHints, ["refresh_token", "access_token"]);
  assert.deepEqual(revoked, { connectedAppId: "notes", revoked: true, upstreamStatus: 204 });
  assert.equal(service.profile("notes")!.status, "revoked");
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM connected_app_credentials").get() as { count: number }).count, 0);
});

test("connected app discovery rejects protected-resource and issuer mix-up", async () => {
  const resourceMismatch = oauthFixture({ resource: "https://attacker.example/mcp" });
  await assert.rejects(
    resourceMismatch.service.createProfile({ id: "bad-resource", displayName: "Bad", resourceUrl: RESOURCE }),
    (error: unknown) => (error as ConnectedAppAuthorityError).code === "oauth_resource_mismatch",
  );
  const issuerMismatch = oauthFixture({ issuer: "https://attacker.example" });
  await assert.rejects(
    issuerMismatch.service.createProfile({ id: "bad-issuer", displayName: "Bad", resourceUrl: RESOURCE }),
    (error: unknown) => (error as ConnectedAppAuthorityError).code === "oauth_issuer_mismatch",
  );
});

test("connected app authority rejects local resource URLs and redacts upstream OAuth secrets", async () => {
  const fixture = oauthFixture({ tokenError: { status: 400, body: { error: "invalid_grant", refresh_token: "echoed-secret" } } });
  await assert.rejects(
    fixture.service.createProfile({ id: "local", displayName: "Local", resourceUrl: "https://127.0.0.1/mcp" }),
    (error: unknown) => (error as ConnectedAppAuthorityError).code === "invalid_input",
  );
  await fixture.service.createProfile({ id: "notes", displayName: "Notes", resourceUrl: RESOURCE });
  const started = await fixture.service.beginOAuth("notes", "http://127.0.0.1:41414/api/connected-apps/oauth/callback");
  const state = new URL(started.authorizationUrl).searchParams.get("state")!;
  await assert.rejects(fixture.service.completeOAuth(state, "authorization-code"), (error: unknown) => {
    const authorityError = error as ConnectedAppAuthorityError;
    assert.equal(authorityError.code, "oauth_upstream_error");
    assert.deepEqual(authorityError.upstream, { error: "invalid_grant", refresh_token: "[redacted]" });
    assert.equal(JSON.stringify(authorityError).includes("echoed-secret"), false);
    return true;
  });
  assert.equal(fixture.service.profile("notes")!.status, "authorization_required");
});
