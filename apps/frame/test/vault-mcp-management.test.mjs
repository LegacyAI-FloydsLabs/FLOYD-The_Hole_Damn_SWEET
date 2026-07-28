import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createVaultMcpManagement } from "../server/vault-mcp-management.mjs";
import {
  applyVaultMcpMigration,
  planVaultMcpMigration,
  reconcileVaultMcpProviderCredentials,
} from "../../../lib/vault-mcp-migration.mjs";

describe("Keychain-backed Vault MCP management", () => {
  it("rejects divergent stdio credentials for the same provider before migration", () => {
    const plans = [
      { providerCredentials: [{ provider: "github", value: "first", source: { path: "a" } }] },
      { providerCredentials: [{ provider: "github", value: "second", source: { path: "b" } }] },
    ];
    assert.throws(
      () => reconcileVaultMcpProviderCredentials(plans, {}),
      /credential conflict for provider github/,
    );
    assert.deepEqual(
      reconcileVaultMcpProviderCredentials([plans[0]], { github: { key: "first" } }),
      plans[0].providerCredentials,
    );
  });
  it("creates, resolves, redacts, and deletes authenticated targets", async () => {
    let keychainAccount = null;
    const management = createVaultMcpManagement({
      readTargets: async () => keychainAccount,
      writeTargets: async (next) => { keychainAccount = structuredClone(next); },
    });
    const created = await management.upsert("private-search", {
      url: "https://mcp.example.test/stream?tenant=private",
      headers: { authorization: "Bearer real-secret", "x-api-key": "real-key" },
      apps: ["cursem"],
    });
    assert.deepEqual(created, {
      id: "private-search",
      configured: true,
      apps: ["cursem"],
      headerNames: ["authorization", "x-api-key"],
    });
    assert.doesNotMatch(JSON.stringify(await management.list()), /mcp\.example|real-secret|real-key|tenant=private/);
    assert.deepEqual(await management.resolveTarget({ id: "private-search", app: "cursem" }), {
      url: "https://mcp.example.test/stream?tenant=private",
      headers: { authorization: "Bearer real-secret", "x-api-key": "real-key" },
    });
    await assert.rejects(
      management.resolveTarget({ id: "private-search", app: "omf" }),
      (error) => error.status === 403,
    );
    assert.equal(await management.remove("private-search"), true);
    assert.equal(await management.resolveTarget({ id: "private-search", app: "cursem" }), null);
  });

  it("rehearses and atomically applies a lossless CURSEM remote MCP migration", async () => {
    const original = JSON.stringify({
      mcpServers: {
        local: { url: "http://127.0.0.1:7777", label: "keep me" },
        remote: {
          url: "https://mcp.example.test/api?tenant=secret",
          headers: { authorization: "Bearer real-secret" },
          label: "preserved metadata",
        },
        githubStdio: {
          command: "github-mcp",
          args: ["--stdio"],
          env: {
            LOG_LEVEL: "info",
            GITHUB_PAT: "github_pat_real-secret",
            GITHUB_BASE_URL: "https://api.github.com",
          },
        },
      },
      unrelated: { preserved: true },
    }, null, 2);
    const path = "/workspace/.cursem/mcp.json";
    const plan = planVaultMcpMigration({ sourcePath: path, text: original });
    assert.equal(plan.changed, true);
    assert.equal(plan.targets.length, 1);
    assert.deepEqual(plan.providerCredentials, [{
      provider: "github",
      value: "github_pat_real-secret",
      source: { path, serverId: "githubStdio", name: "GITHUB_PAT" },
    }]);
    assert.equal(plan.targets[0].url, "https://mcp.example.test/api?tenant=secret");
    assert.equal(plan.targets[0].headers.authorization, "Bearer real-secret");
    assert.doesNotMatch(plan.updatedText, /mcp\.example|real-secret|tenant=secret/);
    const updated = JSON.parse(plan.updatedText);
    assert.deepEqual(updated.mcpServers.local, { url: "http://127.0.0.1:7777", label: "keep me" });
    assert.equal(updated.mcpServers.remote.label, "preserved metadata");
    assert.match(updated.mcpServers.remote.vault.target, /^cursem-remote-/);
    assert.deepEqual(updated.mcpServers.githubStdio, {
      command: "github-mcp",
      args: ["--stdio"],
      env: { LOG_LEVEL: "info" },
      vaultEnv: { GITHUB_PAT: "github", GITHUB_BASE_URL: "github" },
    });
    assert.deepEqual(updated.unrelated, { preserved: true });

    let applicationFile = original;
    const vaultTargets = new Map();
    const applied = await applyVaultMcpMigration({
      plan,
      putTarget: async (target) => {
        const previous = vaultTargets.get(target.id);
        vaultTargets.set(target.id, structuredClone(target));
        return async () => {
          if (previous) vaultTargets.set(target.id, previous);
          else vaultTargets.delete(target.id);
        };
      },
      putProviderCredential: async (credential) => {
        const id = `provider:${credential.provider}`;
        const previous = vaultTargets.get(id);
        vaultTargets.set(id, structuredClone(credential));
        return async () => {
          if (previous) vaultTargets.set(id, previous);
          else vaultTargets.delete(id);
        };
      },
      writeConfig: async (_source, text) => { applicationFile = text; },
    });
    assert.equal(vaultTargets.size, 2);
    assert.equal(applicationFile, plan.updatedText);
    await applied.rollback();
    assert.equal(vaultTargets.size, 0);
    assert.equal(applicationFile, original);
  });

  it("rolls back imported Keychain targets if the app config write fails", async () => {
    const original = JSON.stringify({
      mcpServers: { remote: { url: "https://mcp.example.test", headers: { authorization: "secret" } } },
    });
    const plan = planVaultMcpMigration({ sourcePath: "/workspace/mcp.json", text: original });
    const imported = new Set();
    await assert.rejects(applyVaultMcpMigration({
      plan,
      putTarget: async (target) => {
        imported.add(target.id);
        return async () => imported.delete(target.id);
      },
      writeConfig: async () => { throw new Error("disk failure"); },
    }), /disk failure/);
    assert.equal(imported.size, 0);
  });
});
