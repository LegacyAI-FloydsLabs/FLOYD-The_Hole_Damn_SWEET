import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { normalizeOmpArgs, prepareOmpInvocation } from "../../../lib/omf-vault-args.mjs";
import { createVaultOmpBroker } from "../server/vault-omf-broker.mjs";

const TOKEN = `fv_omf_${"b".repeat(32)}`;

describe("OMF Vault broker and launcher contract", () => {
  it("keeps provider commands available while making Vault win over --api-key", () => {
    assert.deepEqual(
      normalizeOmpArgs(["search", "--provider", "tavily", "--api-key", "real-key", "query"], TOKEN),
      ["search", "--provider", "tavily", "--api-key", TOKEN, "query"],
    );
    assert.deepEqual(
      normalizeOmpArgs(["token", "github", "--api-key=real-key"], TOKEN),
      ["token", "github", `--api-key=${TOKEN}`],
    );
    assert.deepEqual(
      prepareOmpInvocation(["auth-broker", "login", "tavily"], TOKEN),
      { kind: "vault-handoff", managementUrl: "http://127.0.0.1:13030/#vault" },
    );
    assert.equal(
      prepareOmpInvocation(["token", "github"], TOKEN).kind,
      "launch",
    );
  });

  it("serves only fv_ snapshot credentials and hands credential entry to Frame Vault", async () => {
    const enabled = [];
    const broker = createVaultOmpBroker({
      providers: ["tavily", "github", "zai"],
      setProviderEnabled: async (provider, value) => enabled.push({ provider, value }),
    });

    const snapshot = await request(broker, {
      method: "GET",
      path: "/omf-broker/v1/snapshot",
      app: "omf",
      token: TOKEN,
    });
    assert.equal(snapshot.status, 200);
    const snapshotBody = JSON.parse(snapshot.body);
    assert.deepEqual(snapshotBody.credentials.map((entry) => entry.provider), ["tavily", "github", "zai"]);
    assert.ok(snapshotBody.credentials.every((entry) => entry.credential.key === TOKEN));
    assert.doesNotMatch(snapshot.body, /real-provider-key/);

    const upload = await request(broker, {
      method: "POST",
      path: "/omf-broker/v1/credential",
      app: "omf",
      token: TOKEN,
      body: { provider: "tavily", credential: { type: "api_key", key: "real-provider-key" } },
    });
    assert.equal(upload.status, 409);
    assert.deepEqual(enabled, []);
    assert.doesNotMatch(upload.body, /real-provider-key/);
    assert.match(upload.body, /Floyd Vault/);
    assert.match(upload.body, /127\.0\.0\.1:13030/);
  });

  it("keeps OMF broker authority scoped to the OMF capability", async () => {
    const broker = createVaultOmpBroker({ providers: ["tavily"] });
    const response = await request(broker, {
      method: "GET",
      path: "/omf-broker/v1/snapshot",
      app: "cursem",
      token: TOKEN,
    });
    assert.equal(response.status, 403);
  });

  it("reports only configured and enabled providers and persists disable/refresh", async () => {
    const state = {
      tavily: { configured: true, enabled: true },
      github: { configured: false, enabled: true },
      zai: { configured: true, enabled: false },
    };
    const broker = createVaultOmpBroker({
      providers: ["tavily", "github", "zai"],
      getProviderState: async () => state,
      setProviderEnabled: async (provider, enabled) => {
        state[provider] = { ...state[provider], enabled };
      },
    });
    const first = await request(broker, {
      method: "GET", path: "/omf-broker/v1/snapshot", app: "omf", token: TOKEN,
    });
    assert.deepEqual(JSON.parse(first.body).credentials.map(({ provider }) => provider), ["tavily"]);
    const disable = await request(broker, {
      method: "POST", path: "/omf-broker/v1/credential/1/disable", app: "omf", token: TOKEN,
    });
    assert.equal(disable.status, 200);
    assert.equal(state.tavily.enabled, false);
    const missing = await request(broker, {
      method: "POST", path: "/omf-broker/v1/credential/2/refresh", app: "omf", token: TOKEN,
    });
    assert.equal(missing.status, 404);
    const refresh = await request(broker, {
      method: "POST", path: "/omf-broker/v1/credential/3/refresh", app: "omf", token: TOKEN,
    });
    assert.equal(refresh.status, 200);
    assert.equal(state.zai.enabled, true);
  });

  it("preserves credential-free OMF settings, extensions, hooks, skills, and MCP references", () => {
    const root = mkdtempSync(join(tmpdir(), "floyd-omf-state-"));
    const source = join(root, "source");
    const managed = join(root, "managed");
    const profile = join(root, "omf.json");
    for (const directory of ["extensions", "hooks", "skills/example"]) {
      mkdirSync(join(source, directory), { recursive: true });
    }
    writeFileSync(join(source, "extensions", "keep.js"), "export default {};\n");
    writeFileSync(join(source, "hooks", "keep.js"), "export default {};\n");
    writeFileSync(join(source, "skills", "example", "SKILL.md"), "# Keep\n");
    writeFileSync(join(source, "config.yml"), [
      "theme: floyd",
      "tools.approvalMode: write",
      "auth.broker.token: real-broker-secret",
      "",
    ].join("\n"));
    writeFileSync(join(source, "mcp.json"), JSON.stringify({
      mcpServers: {
        private: { vault: { target: "private-search" }, label: "preserved" },
      },
    }));
    writeFileSync(join(source, "agent.db"), "must-not-copy");
    writeFileSync(profile, JSON.stringify({
      app: "omf",
      proxyUrl: "http://127.0.0.1:13031",
      proxyToken: TOKEN,
    }));

    const result = spawnSync(process.execPath, [
      "scripts/materialize-vault-client-config.mjs",
      "omf",
      profile,
      source,
      managed,
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(managed, "extensions", "keep.js"), "utf8"), "export default {};\n");
    assert.equal(readFileSync(join(managed, "hooks", "keep.js"), "utf8"), "export default {};\n");
    assert.equal(readFileSync(join(managed, "skills", "example", "SKILL.md"), "utf8"), "# Keep\n");
    const settings = readFileSync(join(managed, "config.yml"), "utf8");
    assert.match(settings, /theme: floyd/);
    assert.match(settings, /tools\.approvalMode: write/);
    assert.doesNotMatch(settings, /real-broker-secret|auth\.broker\.token/);
    const mcp = JSON.parse(readFileSync(join(managed, "mcp.json"), "utf8"));
    assert.deepEqual(mcp.mcpServers.private, {
      label: "preserved",
      url: "http://127.0.0.1:13031/mcp/private-search",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.throws(() => readFileSync(join(managed, "agent.db")), /ENOENT/);
    const policy = JSON.parse(readFileSync(join(managed, "vault-policy.yml"), "utf8"));
    assert.equal(policy["web_search.enabled"], true);
    assert.equal(policy["github.enabled"], true);
    assert.equal(policy["mcp.enableProjectConfig"], true);
    assert.equal("disabledProviders" in policy, false);
  });

  it("preserves the last verified OMF binary unless rebuild and Vault marker gates pass", () => {
    const launch = readFileSync("intake/surfaces/omf/launch.sh", "utf8");
    const patcher = readFileSync("scripts/apply-omf-vault-routing-patch.sh", "utf8");
    const brandingGate = launch.indexOf('if ! "${CANON}/customizations/apply-floyd-branding.sh"');
    const patchGate = launch.indexOf("elif ! PATCH_RESULT=");
    const rebuildGate = launch.indexOf('bun run build');
    const candidateCopy = launch.indexOf('cp "${CANON_BIN}" "${CANDIDATE}"');
    const candidateProof = launch.indexOf('node "${VERIFY_TOOLS}" "${CANDIDATE}"');
    const atomicReplace = launch.indexOf('mv "${CANDIDATE}" "${COPY_BIN}"');
    const runtimeProof = launch.indexOf('node "${VERIFY_TOOLS}" --fail-closed-only "${COPY_BIN}"');
    const runtimeExec = launch.lastIndexOf('exec node "${HERE}/../../../scripts/run-omf-with-vault.mjs"');

    for (const gate of [
      brandingGate,
      patchGate,
      rebuildGate,
      candidateCopy,
      candidateProof,
      atomicReplace,
      runtimeProof,
      runtimeExec,
    ]) {
      assert.notEqual(gate, -1);
    }
    assert.ok(brandingGate < patchGate);
    assert.ok(patchGate < rebuildGate);
    assert.ok(rebuildGate < candidateCopy);
    assert.ok(candidateCopy < candidateProof);
    assert.ok(candidateProof < atomicReplace);
    assert.ok(atomicReplace < runtimeProof);
    assert.ok(runtimeProof < runtimeExec);
    assert.match(launch, /PATCH_RESULT.*OMF_VAULT_PATCH_CHANGED=1/s);
    assert.match(launch, /failed.*preserving last verified runtime binary/s);
    assert.match(patcher, /OMF_VAULT_PATCH_CHANGED=0/);
    assert.match(patcher, /OMF_VAULT_PATCH_CHANGED=1/);
  });
});

async function request(broker, { method, path, app, token, body }) {
  const res = captureResponse();
  const handled = await broker.handle({
    req: { method, headers: {} },
    res,
    requestUrl: new URL(`http://127.0.0.1:13031${path}`),
    body: body ? Buffer.from(JSON.stringify(body)) : null,
    app,
    token,
  });
  assert.equal(handled, true);
  return {
    status: res.status,
    headers: res.headers,
    body: Buffer.concat(res.chunks).toString("utf8"),
  };
}

function captureResponse() {
  return {
    status: null,
    headers: {},
    chunks: [],
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    write(chunk) { this.chunks.push(Buffer.from(chunk)); },
    end(chunk) { if (chunk !== undefined) this.write(chunk); },
  };
}
