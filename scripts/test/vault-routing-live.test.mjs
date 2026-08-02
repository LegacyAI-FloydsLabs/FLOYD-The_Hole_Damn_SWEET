import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  applyFloydModelPolicy,
  buildFloydProviderConfig,
  buildFloydProviderConfigLive,
  fetchVaultKeyedProviders,
  resolveZaiModelTiers,
} from "../../lib/vault-routing.mjs";

const token = `fv_ff_${"b".repeat(48)}`;
const proxy = "http://127.0.0.1:13031";

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test("live aggregate merges models with pinned anthropic IDs first", async () => {
  const config = await buildFloydProviderConfigLive(token, proxy, {
    fetchImpl: async (url, init) => {
      assert.equal(url, `${proxy}/models`);
      assert.equal(init.headers.authorization, `Bearer ${token}`);
      return jsonResponse({
        providers: {
          anthropic: {
            provider: "anthropic",
            source: "live",
            fetchedAt: "2026-07-31T00:00:00-04:00",
            models: [
              { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
              { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
            ],
          },
          zai: {
            provider: "zai",
            source: "live",
            fetchedAt: "2026-07-31T00:00:00-04:00",
            models: [
              { id: "glm-4.5" },
              { id: "glm-4.7" },
              { id: "glm-5.2" },
            ],
          },
          openai: {
            provider: "openai",
            source: "live",
            fetchedAt: "2026-07-31T00:00:00-04:00",
            models: [{ id: "gpt-99-should-not-appear" }],
          },
        },
      });
    },
  });

  assert.deepEqual(
    config.anthropic.models.map((model) => model.id),
    ["claude-sonnet-4-6", "claude-sonnet-4-5-20250929", "claude-3-5-haiku-20241022", "claude-opus-4-7"],
  );
  assert.deepEqual(
    config.zai.models.map((model) => model.id),
    ["glm-4.5", "glm-4.7", "glm-5.2"],
  );
  assert.equal(config.zai.models[0].name, "glm-4.5");
  // The ChatGPT subscription has no list endpoint; the static entry stays.
  assert.deepEqual(config.openai.models, [{ id: "gpt-5.2-codex", name: "gpt-5.2-codex" }]);
  // Providers absent from the aggregate keep their static arrays.
  assert.deepEqual(config.google.models, [{ id: "gemini-2.5-pro", name: "gemini-2.5-pro" }]);
  assert.equal(config.zai.api_key, token);
  assert.equal(config.zai.base_url, `${proxy}/p/zai/api/coding/paas/v4`);
});

test("fetch failure falls back to the static provider config", async () => {
  const config = await buildFloydProviderConfigLive(token, proxy, {
    fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); },
  });
  assert.deepEqual(config, buildFloydProviderConfig(token, proxy));
});

test("non-OK model route falls back to the static provider config", async () => {
  const config = await buildFloydProviderConfigLive(token, proxy, {
    fetchImpl: async () => jsonResponse({}, 404),
  });
  assert.deepEqual(config, buildFloydProviderConfig(token, proxy));
});

test("keyed provider set comes from /status with subscription-gated openai", async () => {
  const keyed = await fetchVaultKeyedProviders(token, proxy, {
    fetchImpl: async (url, init) => {
      assert.equal(url, `${proxy}/status`);
      assert.equal(init.headers.authorization, `Bearer ${token}`);
      return jsonResponse({
        ok: true,
        configuredProviders: ["zai", "anthropic", "tavily", "not-a-provider"],
        subscriptionConfigured: true,
      });
    },
  });
  assert.deepEqual([...keyed].sort(), ["anthropic", "openai", "tavily", "zai"]);

  const noSubscription = await fetchVaultKeyedProviders(token, proxy, {
    fetchImpl: async () => jsonResponse({ configuredProviders: ["zai"], subscriptionConfigured: false }),
  });
  assert.deepEqual([...noSubscription], ["zai"]);

  const offline = await fetchVaultKeyedProviders(token, proxy, {
    fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); },
  });
  assert.equal(offline, null);
});

test("keyed filtering drops unkeyed providers from live and fallback configs", async () => {
  const keyedProviders = new Set(["zai", "anthropic"]);
  const fetchImpl = async (url) => {
    if (url.endsWith("/models")) {
      return jsonResponse({
        providers: { zai: { models: [{ id: "glm-5.2" }] } },
      });
    }
    return jsonResponse({}, 404);
  };
  const live = await buildFloydProviderConfigLive(token, proxy, { fetchImpl, keyedProviders });
  assert.deepEqual(Object.keys(live).sort(), ["anthropic", "zai"]);
  assert.deepEqual(live.zai.models.map((model) => model.id), ["glm-5.2"]);
  // The pinned catwalk IDs survive inside the keyed anthropic entry.
  assert.deepEqual(
    live.anthropic.models.slice(0, 3).map((model) => model.id),
    ["claude-sonnet-4-6", "claude-sonnet-4-5-20250929", "claude-3-5-haiku-20241022"],
  );

  const offline = await buildFloydProviderConfigLive(token, proxy, {
    fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); },
    keyedProviders,
  });
  assert.deepEqual(Object.keys(offline).sort(), ["anthropic", "zai"]);
  assert.deepEqual(offline.zai.models, [{ id: "glm-4.7", name: "glm-4.7" }]);
});

test("zai tiers: large is the highest glm version, small is the air entry", () => {
  const list = ["glm-4.5", "glm-4.5-air", "glm-4.6", "glm-4.7", "glm-5", "glm-5-turbo", "glm-5.1", "glm-5.2"]
    .map((id) => ({ id, name: id }));
  assert.deepEqual(resolveZaiModelTiers(list), { large: "glm-5.2", small: "glm-4.5-air" });
  // Without an air entry the fast tier falls back to the first list entry.
  assert.deepEqual(
    resolveZaiModelTiers([{ id: "glm-4.7" }, { id: "glm-5.2" }]),
    { large: "glm-5.2", small: "glm-4.7" },
  );
  assert.equal(resolveZaiModelTiers([]), null);
  assert.equal(resolveZaiModelTiers(undefined), null);
});

test("model policy seeds tiers, preserves keyed picks, reseeds stale picks", () => {
  const zai = { models: ["glm-4.5", "glm-4.5-air", "glm-5.2"].map((id) => ({ id, name: id })) };
  const keyedProviders = new Set(["zai", "anthropic", "moonshot"]);

  const fresh = applyFloydModelPolicy({ providers: { zai } }, keyedProviders);
  assert.deepEqual(fresh.models.large, { model: "glm-5.2", provider: "zai" });
  assert.deepEqual(fresh.models.small, { model: "glm-4.5-air", provider: "zai" });

  const keyedPick = applyFloydModelPolicy({
    providers: { zai },
    models: { large: { model: "kimi-k2.5", provider: "moonshot", reasoning_effort: "low" } },
  }, keyedProviders);
  assert.deepEqual(keyedPick.models.large, { model: "kimi-k2.5", provider: "moonshot", reasoning_effort: "low" });

  const stalePick = applyFloydModelPolicy({
    providers: { zai },
    models: { large: { model: "grok-4", provider: "xai", reasoning_effort: "low", max_tokens: 8192 } },
    recent_models: [
      { model: "grok-4", provider: "xai" },
      { model: "glm-4.7", provider: "zai" },
    ],
  }, keyedProviders);
  // Stale provider: model/provider reseed, tuned extra fields preserved.
  assert.deepEqual(stalePick.models.large, { model: "glm-5.2", provider: "zai", reasoning_effort: "low", max_tokens: 8192 });
  assert.deepEqual(stalePick.models.small, { model: "glm-4.5-air", provider: "zai" });
  assert.deepEqual(stalePick.recent_models, [{ model: "glm-4.7", provider: "zai" }]);

  // Unknown keyed set (status route down) preserves everything.
  const blind = applyFloydModelPolicy({
    providers: { zai },
    models: { large: { model: "grok-4", provider: "xai" } },
    recent_models: [{ model: "grok-4", provider: "xai" }],
  }, null);
  assert.deepEqual(blind.models.large, { model: "grok-4", provider: "xai" });
  assert.equal(blind.recent_models.length, 1);
});

const stubStatus = {
  ok: true,
  configuredProviders: ["zai", "anthropic", "google", "tavily"],
  subscriptionConfigured: true,
};
const stubModels = {
  providers: {
    zai: { provider: "zai", source: "live", models: [{ id: "glm-4.5" }, { id: "glm-4.5-air" }, { id: "glm-5.2" }] },
    anthropic: { provider: "anthropic", source: "live", models: [{ id: "claude-opus-4-7" }] },
  },
};

async function withStubVault(body) {
  const server = createServer((req, res) => {
    const payload = req.url === "/status" ? stubStatus : req.url === "/models" ? stubModels : null;
    res.writeHead(payload ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(payload ?? {}));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    await body(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

const materializeScript = resolve("scripts/materialize-vault-client-config.mjs");
const mergeConfigScript = resolve("intake/surfaces/launcher/agents/lib/merge-config.mjs");
// Async exec: the stub Vault server lives in this process, so a synchronous
// exec would block the event loop and deadlock the child's fetches.
const execFileAsync = promisify(execFile);

function writeProfile(root, app, proxyUrl) {
  const profile = join(root, `${app}.json`);
  writeFileSync(profile, JSON.stringify({ version: 1, app, proxyUrl, proxyToken: token }));
  return profile;
}

test("ff materialization keeps only keyed providers and seeds GLM tiers", async () => {
  await withStubVault(async (proxyUrl) => {
    const root = mkdtempSync(join(tmpdir(), "floyd-ff-keyed-"));
    const source = join(root, "source");
    const managed = join(root, "managed");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "floyd.json"), JSON.stringify({
      models: { large: { model: "kimi-k2.5", provider: "moonshot", reasoning_effort: "low" } },
      recent_models: [
        { model: "grok-4", provider: "xai" },
        { model: "glm-4.7", provider: "zai" },
      ],
    }));
    const profile = writeProfile(root, "ff", proxyUrl);
    await execFileAsync(process.execPath, [materializeScript, "ff", profile, source, managed]);
    const config = JSON.parse(readFileSync(join(managed, "floyd.json"), "utf8"));

    assert.deepEqual(Object.keys(config.providers), ["openai", "anthropic", "google", "zai"]);
    assert.deepEqual(
      config.providers.anthropic.models.map((model) => model.id),
      ["claude-sonnet-4-6", "claude-sonnet-4-5-20250929", "claude-3-5-haiku-20241022", "claude-opus-4-7"],
    );
    assert.deepEqual(config.providers.zai.models.map((model) => model.id), ["glm-4.5", "glm-4.5-air", "glm-5.2"]);
    // The moonshot pick lost its key: reseed to zai, keep the tuned field.
    assert.deepEqual(config.models.large, { model: "glm-5.2", provider: "zai", reasoning_effort: "low" });
    assert.deepEqual(config.models.small, { model: "glm-4.5-air", provider: "zai" });
    assert.deepEqual(config.recent_models, [{ model: "glm-4.7", provider: "zai" }]);
  });
});

test("ff materialization preserves a user pick whose provider is keyed", async () => {
  await withStubVault(async (proxyUrl) => {
    const root = mkdtempSync(join(tmpdir(), "floyd-ff-preserve-"));
    const source = join(root, "source");
    const managed = join(root, "managed");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "floyd.json"), JSON.stringify({
      models: {
        large: { model: "claude-opus-4-7", provider: "anthropic", max_tokens: 8192 },
        small: { model: "glm-4.6", provider: "zai" },
      },
    }));
    const profile = writeProfile(root, "ff", proxyUrl);
    await execFileAsync(process.execPath, [materializeScript, "ff", profile, source, managed]);
    const config = JSON.parse(readFileSync(join(managed, "floyd.json"), "utf8"));
    assert.deepEqual(config.models.large, { model: "claude-opus-4-7", provider: "anthropic", max_tokens: 8192 });
    assert.deepEqual(config.models.small, { model: "glm-4.6", provider: "zai" });
  });
});

test("ff pick stored in the managed file survives the next materialize", async () => {
  await withStubVault(async (proxyUrl) => {
    const root = mkdtempSync(join(tmpdir(), "floyd-ff-stick-"));
    const source = join(root, "source");
    const managed = join(root, "managed");
    // The source still holds an older pick; the managed file holds the pick
    // the user made in the TUI afterwards. The managed pick must win.
    mkdirSync(source, { recursive: true });
    mkdirSync(managed, { recursive: true });
    writeFileSync(join(source, "floyd.json"), JSON.stringify({
      models: { large: { model: "gemini-2.5-pro", provider: "google" } },
    }));
    writeFileSync(join(managed, "floyd.json"), JSON.stringify({
      models: {
        large: { model: "claude-opus-4-7", provider: "anthropic", reasoning_effort: "high" },
        small: { model: "glm-4.7", provider: "zai" },
      },
      recent_models: [
        { model: "grok-4", provider: "xai" },
        { model: "claude-opus-4-7", provider: "anthropic" },
      ],
    }));
    const profile = writeProfile(root, "ff", proxyUrl);
    await execFileAsync(process.execPath, [materializeScript, "ff", profile, source, managed]);
    const config = JSON.parse(readFileSync(join(managed, "floyd.json"), "utf8"));
    assert.deepEqual(config.models.large, { model: "claude-opus-4-7", provider: "anthropic", reasoning_effort: "high" });
    assert.deepEqual(config.models.small, { model: "glm-4.7", provider: "zai" });
    // recent_models carries forward too, minus the keyless xai entry.
    assert.deepEqual(config.recent_models, [{ model: "claude-opus-4-7", provider: "anthropic" }]);
  });
});

test("ff managed pick is reseeded to GLM when its provider lost its key", async () => {
  await withStubVault(async (proxyUrl) => {
    const root = mkdtempSync(join(tmpdir(), "floyd-ff-lostkey-"));
    const source = join(root, "source");
    const managed = join(root, "managed");
    mkdirSync(source, { recursive: true });
    mkdirSync(managed, { recursive: true });
    writeFileSync(join(managed, "floyd.json"), JSON.stringify({
      models: {
        large: { model: "kimi-k2.5", provider: "moonshot", reasoning_effort: "low" },
        small: { model: "grok-4", provider: "xai" },
      },
      recent_models: [
        { model: "kimi-k2.5", provider: "moonshot" },
        { model: "glm-4.7", provider: "zai" },
      ],
    }));
    const profile = writeProfile(root, "ff", proxyUrl);
    await execFileAsync(process.execPath, [materializeScript, "ff", profile, source, managed]);
    const config = JSON.parse(readFileSync(join(managed, "floyd.json"), "utf8"));
    // moonshot and xai are unkeyed in the stub: both slots reseed, tuned
    // fields kept, and the stale recent entry is filtered out.
    assert.deepEqual(config.models.large, { model: "glm-5.2", provider: "zai", reasoning_effort: "low" });
    assert.deepEqual(config.models.small, { model: "glm-4.5-air", provider: "zai" });
    assert.deepEqual(config.recent_models, [{ model: "glm-4.7", provider: "zai" }]);
  });
});

test("omf materialization keeps only keyed provider groups", async () => {
  await withStubVault(async (proxyUrl) => {
    const root = mkdtempSync(join(tmpdir(), "floyd-omf-keyed-"));
    const source = join(root, "source");
    const managed = join(root, "managed");
    mkdirSync(source, { recursive: true });
    const profile = writeProfile(root, "omf", proxyUrl);
    await execFileAsync(process.execPath, [materializeScript, "omf", profile, source, managed]);
    const models = JSON.parse(readFileSync(join(managed, "models.yml"), "utf8"));
    assert.deepEqual(
      Object.keys(models.providers).sort(),
      ["anthropic", "google", "openai", "zai", "zhipu-coding-plan"],
    );
  });
});

test("launcher merge seeds tiers and filters providers without losing overlays", async () => {
  await withStubVault(async (proxyUrl) => {
    const root = mkdtempSync(join(tmpdir(), "floyd-launcher-"));
    const agentHome = join(root, "agents", "code-implementer");
    mkdirSync(agentHome, { recursive: true });
    const base = join(root, "base.json");
    const overlay = join(root, "overlay.json");
    const out = join(root, "out", "floyd.json");
    writeFileSync(base, JSON.stringify({ options: { theme: "floyd" } }));
    writeFileSync(overlay, JSON.stringify({
      models: { large: { model: "glm-4.7", provider: "zai", temperature: 0.1 } },
    }));
    const profile = writeProfile(root, "launcher", proxyUrl);
    await execFileAsync(process.execPath, [mergeConfigScript, base, overlay, agentHome, out], {
      env: {
        ...process.env,
        FLOYD_VAULT_APP_PROFILE: profile,
        FLOYD_AGENT_MODELS_PATH: join(root, "no-user-picks.json"),
        FLOYD_AGENT_EXTRA_OVERLAY: "",
      },
    });
    const merged = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(Object.keys(merged.providers), ["openai", "anthropic", "google", "zai"]);
    // Keyed agent pin survives with its tuned fields; small tier is seeded.
    assert.deepEqual(merged.models.large, { model: "glm-4.7", provider: "zai", temperature: 0.1 });
    assert.deepEqual(merged.models.small, { model: "glm-4.5-air", provider: "zai" });
    assert.equal(merged.options.theme, "floyd");
    assert.equal(merged.options.disable_default_providers, true);
  });
});
