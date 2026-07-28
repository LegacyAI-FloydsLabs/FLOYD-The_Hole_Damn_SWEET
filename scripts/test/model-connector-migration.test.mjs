import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { ConnectorAuthorityService } from "../../apps/frame/server/model-connector-authority.ts";
import { migrateModelConnectorState } from "../lib/model-connector-migration.mjs";

test("model-connector migration preserves rows and decrypts all secret classes before removing Core tables", async () => {
  const root = mkdtempSync(join(tmpdir(), "model-connector-migration-"));
  const sourcePath = join(root, "core.sqlite");
  const targetPath = join(root, "vault.sqlite");
  const masterKey = randomBytes(32);
  const source = new DatabaseSync(sourcePath);
  const authority = new ConnectorAuthorityService(source, { masterKey });
  authority.createProfile({
    id: "proof",
    displayName: "Proof",
    provider: "openai",
    baseUrl: "https://models.example/v1",
    clientId: "proof-client",
    clientSecret: "proof-client-secret",
    clientAuth: "client_secret_basic",
    authorizationUrl: "https://auth.example/authorize",
    tokenUrl: "https://auth.example/token",
    scopes: ["models"],
  });
  authority.storeApiKey("proof", "proof-api-secret");
  authority.beginOAuth("proof", "http://127.0.0.1:13031/connectors/oauth/callback");
  source.close();

  const result = migrateModelConnectorState({
    sourcePath,
    targetPath,
    masterKey,
    removeSource: true,
  });
  assert.deepEqual(result.counts, {
    connector_profiles: 1,
    connector_credentials: 1,
    connector_oauth_attempts: 1,
    connector_evidence_outbox: 0,
  });
  assert.equal(result.encryptedValuesVerified, 3);
  assert.equal(result.decryptionVerified, true);
  assert.equal(result.sourceRemoved, true);

  const target = new DatabaseSync(targetPath);
  const migrated = new ConnectorAuthorityService(target, { masterKey });
  assert.equal((await migrated.resolve("floyd-connector:proof")).authorization, "Bearer proof-api-secret");
  assert.equal(migrated.profile("proof")?.clientAuth, "client_secret_basic");
  target.close();

  const legacy = new DatabaseSync(sourcePath);
  assert.equal(legacy.prepare(
    "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'connector_%'",
  ).get().count, 0);
  legacy.close();
});

test("model-connector migration cannot remove source state when decryption proof fails", () => {
  const root = mkdtempSync(join(tmpdir(), "model-connector-migration-reject-"));
  const sourcePath = join(root, "core.sqlite");
  const targetPath = join(root, "vault.sqlite");
  const sourceKey = randomBytes(32);
  const source = new DatabaseSync(sourcePath);
  const authority = new ConnectorAuthorityService(source, { masterKey: sourceKey });
  authority.createProfile({
    id: "proof",
    displayName: "Proof",
    provider: "openai",
    baseUrl: "https://models.example/v1",
  });
  authority.storeApiKey("proof", "proof-api-secret");
  source.close();

  assert.throws(() => migrateModelConnectorState({
    sourcePath,
    targetPath,
    masterKey: randomBytes(32),
    removeSource: true,
  }), /credential verification failed/);
  const legacy = new DatabaseSync(sourcePath);
  assert.equal(legacy.prepare(
    "SELECT count(*) AS count FROM connector_credentials",
  ).get().count, 1);
  legacy.close();
});
