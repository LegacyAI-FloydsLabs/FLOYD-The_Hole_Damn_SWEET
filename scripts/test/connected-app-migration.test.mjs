import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { ConnectedAppAuthorityService } from "../../apps/frame/server/connected-app-authority.ts";
import { migrateConnectedAppState } from "../lib/connected-app-migration.mjs";

test("connected-app migration copies all rows, proves decryption, then removes legacy tables", () => {
  const root = mkdtempSync(join(tmpdir(), "connected-app-migration-"));
  const sourcePath = join(root, "core.sqlite");
  const targetPath = join(root, "vault.sqlite");
  const masterKey = randomBytes(32);
  const source = new DatabaseSync(sourcePath);
  new ConnectedAppAuthorityService(source, { masterKey });
  const now = new Date().toISOString();
  source.prepare(
    `INSERT INTO connected_app_profiles
     (id, display_name, resource_url, resource_metadata_url, authorization_server,
      authorization_url, token_url, registration_url, revocation_url,
      scopes_supported_json, scopes_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, '[]', '[]', 'connected', ?, ?)`,
  ).run("proof", "Proof", "https://mcp.example/resource", "https://mcp.example/meta",
    "https://auth.example", "https://auth.example/authorize", "https://auth.example/token", now, now);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  cipher.setAAD(Buffer.from(
    "floyd-connected-app:v1:credential:proof:https://auth.example:https://mcp.example/resource:access",
  ));
  const ciphertext = Buffer.concat([cipher.update("secret-access-token"), cipher.final()]);
  source.prepare(
    `INSERT INTO connected_app_credentials
     (credential_ref, connector_id, access_iv, access_tag, access_ciphertext,
      token_type, scopes_json, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'Bearer', '[]', 1, ?, ?)`,
  ).run("floyd-connected-app:proof", "proof", iv, cipher.getAuthTag(), ciphertext, now, now);
  source.close();

  const result = migrateConnectedAppState({
    sourcePath,
    targetPath,
    masterKey,
    removeSource: true,
  });
  assert.equal(result.counts.connected_app_profiles, 1);
  assert.equal(result.counts.connected_app_credentials, 1);
  assert.equal(result.decryptionVerified, true);
  assert.equal(result.sourceRemoved, true);
  const target = new DatabaseSync(targetPath);
  assert.equal(target.prepare("SELECT count(*) AS count FROM connected_app_profiles").get().count, 1);
  target.close();
  const legacy = new DatabaseSync(sourcePath);
  assert.equal(legacy.prepare(
    "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'connected_app_%'",
  ).get().count, 0);
  legacy.close();
});
