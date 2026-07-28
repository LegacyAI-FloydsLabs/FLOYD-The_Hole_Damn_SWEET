import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  buildFloydProviderConfig,
  buildOpenCodeProviderConfig,
  buildVaultEnvironment,
  applyVaultEnvironment,
  providerProxyUrl,
} from "../lib/vault-routing.mjs";

const ROOT = new URL("..", import.meta.url);
const TOKEN = "fv_regression_0123456789abcdef0123456789abcdef";
const PROXY = "http://127.0.0.1:13031";

test("managed environment always replaces inherited vendor credentials", () => {
  const hostileParent = {
    OPENAI_API_KEY: "real-parent-openai",
    ANTHROPIC_API_KEY: "real-parent-anthropic",
    ZAI_API_KEY: "real-parent-zai",
    GEMINI_API_KEY: "real-parent-google",
    REAL_SECRET: "real-parent-unknown",
    GITHUB_PAT: "real-parent-pat",
    XYZ_TOKEN: "real-parent-token",
    GOOGLE_APPLICATION_CREDENTIALS: "/tmp/real-parent-service-account.json",
    AZURE_CLIENT_SECRET: "real-parent-azure",
    DATABASE_PASSWORD: "real-parent-password",
    MISTRAL_BASE_URL: "https://api.mistral.ai",
  };
  const env = applyVaultEnvironment(hostileParent, "regression", TOKEN, PROXY);
  for (const [name, value] of Object.entries(env)) {
    if (name.endsWith("_API_KEY") || name.endsWith("_TOKEN") || name === "FAL_KEY") {
      assert.equal(value, TOKEN, `${name} did not receive the Vault capability`);
    }
  }
  assert.equal(env.OPENAI_BASE_URL, `${PROXY}/v1`);
  assert.equal(env.ANTHROPIC_BASE_URL, `${PROXY}/p/anthropic`);
  assert.ok(!JSON.stringify(env).includes("real-parent-"));
  assert.equal(env.REAL_SECRET, undefined);
  assert.equal(env.GITHUB_PAT, undefined);
  assert.equal(env.XYZ_TOKEN, undefined);
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(env.AZURE_CLIENT_SECRET, undefined);
  assert.equal(env.DATABASE_PASSWORD, undefined);
});

test("every managed provider route is loopback and carries only an fv token", () => {
  for (const provider of [
    "openai", "anthropic", "google", "deepseek", "mistral", "huggingface",
    "github", "elevenlabs", "zai", "minimax", "moonshot", "tavily",
    "openrouter", "xai", "groq", "fal",
  ]) {
    const url = new URL(providerProxyUrl(PROXY, provider));
    assert.equal(url.hostname, "127.0.0.1", provider);
  }
  const floyd = buildFloydProviderConfig(TOKEN, PROXY);
  for (const config of Object.values(floyd)) {
    assert.equal(config.api_key, TOKEN);
    assert.equal(new URL(config.base_url).hostname, "127.0.0.1");
  }
  const opencode = buildOpenCodeProviderConfig(TOKEN, PROXY);
  assert.equal(opencode.options.apiKey, TOKEN);
  assert.equal(new URL(opencode.options.baseURL).hostname, "127.0.0.1");
});

test("launcher replaces real and stale keys with one Vault capability", () => {
  const dir = mkdtempSync(join(tmpdir(), "floyd-launcher-vault-"));
  const base = join(dir, "base.json");
  const overlay = join(dir, "overlay.json");
  const out = join(dir, "out.json");
  const profile = join(dir, "profile.json");
  writeFileSync(base, JSON.stringify({
    unrelated: { preserve: true },
    providers: {
      zai: { api_key: "real-base-key", base_url: "https://api.z.ai" },
      anthropic: { api_key: "old-real-key", base_url: "https://api.anthropic.com" },
    },
  }));
  writeFileSync(overlay, JSON.stringify({ unrelated: { overlay: "kept" } }));
  writeFileSync(profile, JSON.stringify({ app: "launcher", token: TOKEN, proxy: PROXY }));

  const result = spawnSync(process.execPath, [
    new URL("../intake/surfaces/launcher/agents/lib/merge-config.mjs", import.meta.url).pathname,
    base, overlay, join(dir, "agent"), out,
  ], {
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      FLOYD_VAULT_APP_PROFILE: profile,
      FLOYD_AGENT_MODELS_PATH: join(dir, "missing-models.json"),
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const merged = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(merged.unrelated, { preserve: true, overlay: "kept" });
  assert.ok(!JSON.stringify(merged).includes("real-"));
  assert.ok(!JSON.stringify(merged).includes("old-real"));
  for (const config of Object.values(merged.providers)) {
    assert.equal(config.api_key, TOKEN);
    assert.equal(new URL(config.base_url).hostname, "127.0.0.1");
  }
});

test("generated launcher config refuses credentials hidden outside providers", () => {
  const dir = mkdtempSync(join(tmpdir(), "floyd-launcher-hidden-key-"));
  const base = join(dir, "base.json");
  const overlay = join(dir, "overlay.json");
  const out = join(dir, "out.json");
  const profile = join(dir, "profile.json");
  writeFileSync(base, JSON.stringify({
    plugin: { client_secret: "real-hidden-plugin-secret", endpoint: "https://api.anthropic.com" },
  }));
  writeFileSync(overlay, "{}");
  writeFileSync(profile, JSON.stringify({ app: "launcher", token: TOKEN, proxy: PROXY }));
  const result = spawnSync(process.execPath, [
    new URL("../intake/surfaces/launcher/agents/lib/merge-config.mjs", import.meta.url).pathname,
    base, overlay, join(dir, "agent"), out,
  ], {
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      FLOYD_VAULT_APP_PROFILE: profile,
      FLOYD_AGENT_MODELS_PATH: join(dir, "missing-models.json"),
    },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-Vault credential/);
});

test("tracked managed-app code contains no direct provider credential authority", () => {
  const files = {
    core: "core/daemon/src/engine.ts",
    launcher: "intake/surfaces/launcher/agents/lib/merge-config.mjs",
    cursemRelay: "intake/surfaces/ide/server/gateway-relay.mjs",
    cursemUi: "intake/surfaces/ide/src/model-routing/runtimeConfig.ts",
    desktop: "intake/surfaces/desktop/server/index.ts",
    browork: "intake/surfaces/desktop/server/browork-manager.ts",
    subscription: "intake/surfaces/desktop/server/chatgpt-subscription.ts",
    ttyLive: "apps/frame/extensions/floyd-tty-bridge/live-service.js",
    ttyPanel: "apps/frame/extensions/floyd-tty-bridge/sidepanel.js",
    sdk: "packages/sdk/src/index.ts",
  };
  const source = Object.fromEntries(Object.entries(files).map(([name, path]) => [
    name,
    readFileSync(new URL(`../${path}`, import.meta.url), "utf8"),
  ]));
  assert.doesNotMatch(source.core, /provider-keys\.json|user-opencode-config|api\.z\.ai/);
  assert.doesNotMatch(source.launcher, /provider-keys\.json|using base-config keys|vault unavailable.*base-config/s);
  assert.doesNotMatch(source.cursemRelay, /credentialMode\s*===\s*['"]user['"]|selectUserCredentialHeaders/);
  assert.doesNotMatch(source.cursemUi, /credentialMode:\s*['"]user['"]|apiKey:\s*string/);
  assert.doesNotMatch(source.desktop, /settings\.apiKey|const\s*\{[^}]*apiKey|open\.bigmodel\.cn/s);
  assert.doesNotMatch(source.browork, /private apiKey|setApiKey|open\.bigmodel\.cn/);
  assert.doesNotMatch(source.subscription, /auth\.openai\.com|BACKEND_URL|readAuth\(/);
  assert.doesNotMatch(source.ttyLive, /gemini_api_key|chrome\.storage|generativelanguage\.googleapis\.com/);
  assert.doesNotMatch(source.ttyPanel, /input-api-key|storage\.local\.set\(\{\s*gemini_api_key/);
  assert.match(source.sdk, /storeConnectorApiKey[\s\S]*sealConnectorSecret\(apiKey/);
  assert.doesNotMatch(source.sdk, /x-floyd-credential-ref|route\.apiKey|x-floyd-base-url|sealedApiKey:\s*apiKey/);
});

test("the pinned Gemini Live client honors the Vault WebSocket base and fv token", async () => {
  const originalWebSocket = globalThis.WebSocket;
  let capturedUrl = "";
  globalThis.WebSocket = class {
    constructor(url) {
      capturedUrl = String(url);
      queueMicrotask(() => this.onopen?.({}));
    }
    send() {}
    close() { this.onclose?.({}); }
  };
  try {
    const { GoogleGenAI } = await import("../apps/frame/extensions/floyd-tty-bridge/lib/genai.mjs");
    const token = "fv_ttybridge_0123456789abcdef0123456789abcdef0123456789abcdef";
    const client = new GoogleGenAI({
      apiKey: token,
      httpOptions: { baseUrl: `${PROXY}/p/google` },
    });
    const session = await client.live.connect({
      model: "gemini-live-proof",
      callbacks: { onopen() {}, onmessage() {} },
    });
    assert.equal(
      capturedUrl,
      `ws://127.0.0.1:13031/p/google/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${token}`,
    );
    session.close();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test("Vault management authorization rejects missing, cross-origin, and wrong capabilities", async () => {
  const { authorizeManagementBootstrap, authorizeVaultManagement } = await import("../apps/frame/server/management-auth.mjs");
  const expected = "fm_test_0123456789abcdef";
  const allowed = { host: "127.0.0.1:13030", origin: "http://127.0.0.1:13030", authorization: `Bearer ${expected}` };
  assert.equal(authorizeVaultManagement(allowed, expected), true);
  assert.equal(authorizeVaultManagement({ ...allowed, authorization: undefined }, expected), false);
  assert.equal(authorizeVaultManagement({ ...allowed, authorization: "Bearer wrong" }, expected), false);
  assert.equal(authorizeVaultManagement({ ...allowed, origin: "https://evil.example" }, expected), false);
  assert.equal(authorizeManagementBootstrap({
    host: "127.0.0.1:13030",
    "x-floyd-management-bootstrap": expected,
  }, expected), true);
  assert.equal(authorizeManagementBootstrap({
    host: "127.0.0.1:13030",
    origin: "http://127.0.0.1:13030",
    "x-floyd-management-bootstrap": expected,
  }, expected), false);
  assert.equal(authorizeManagementBootstrap({
    host: "127.0.0.1:13030",
    "x-floyd-management-bootstrap": "wrong",
  }, expected), false);
});

test("TTY Bridge rotation closes live browser sessions before relaunch", () => {
  const source = readFileSync(new URL("../apps/frame/server/frame-server.mjs", import.meta.url), "utf8");
  assert.match(source, /canonical === "ttybridge"[\s\S]*await closeInternalBrowser\(\)[\s\S]*await openChrome\(""\)/);
  assert.match(source, /method:\s*"Browser\.close"/);
});

test("FF, launcher, and OMF login hand off only to native FloydShell Vault mode", () => {
  const script = new URL("../scripts/vault-provider-handoff.mjs", import.meta.url).pathname;
  const source = readFileSync(script, "utf8");
  const omfRunner = readFileSync(new URL("../scripts/run-omf-with-vault.mjs", import.meta.url), "utf8");
  assert.ok(!source.includes("/usr/bin/open"));
  assert.ok(!omfRunner.includes("/usr/bin/open"));
  assert.doesNotMatch(source, /https?:\/\/127\.0\.0\.1[^"']*(?:token|auth)=/i);
  assert.match(source, /FloydShell/);
  assert.match(source, /\["--vault", "--chatgpt-subscription"\]/);
  assert.match(source, /: \["--vault"\]/);
  assert.match(source, /env: childEnv/);
  assert.match(omfRunner, /vault-provider-handoff\.mjs/);
  for (const client of ["ff", "launcher", "omf"]) {
    const result = spawnSync(process.execPath, [script, client, "login"], {
      env: { PATH: process.env.PATH, FLOYD_VAULT_HANDOFF_NO_OPEN: "1" },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Floyd Vault.*FloydShell --vault/);
    assert.doesNotMatch(result.stdout + result.stderr, /sk-|AIza|ghp_|tvly-|hf_|fm_/);
  }
});

test("OpenAI Vault UI is subscription-only and uses the native ChatGPT/Codex handoff", () => {
  const server = readFileSync(new URL("../apps/frame/server/frame-server.mjs", import.meta.url), "utf8");
  const frame = readFileSync(new URL("../apps/frame/public/index.html", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../apps/frame/native/FloydShell.swift", import.meta.url), "utf8");
  const handoff = new URL("../scripts/vault-provider-handoff.mjs", import.meta.url).pathname;
  assert.doesNotMatch(server, /id: "openai"[\s\S]{0,400}platform\.openai\.com\/api-keys/);
  assert.match(server, /credentialMode: "chatgpt-subscription"/);
  assert.match(server, /apiKeyProviders = PROVIDERS\.filter\(\(provider\) => provider\.credentialMode !== "chatgpt-subscription"\)/);
  assert.match(server, /path === "\/api\/keys\/openai\/subscription"[\s\S]*vault-provider-handoff\.mjs[\s\S]*"chatgpt-subscription"/);
  assert.match(frame, /subscription \? `<button class="k-get k-subscription"/);
  assert.match(frame, /OpenAI is subscription-only: Floyd never accepts or distributes an OpenAI API key/);
  assert.doesNotMatch(frame, /OpenAI[^<]{0,100}platform\.openai\.com\/api-keys/);
  assert.match(shell, /--chatgpt-subscription/);
  assert.match(shell, /urlForApplication\(withBundleIdentifier: "com\.openai\.codex"\)/);
  const result = spawnSync(process.execPath, [handoff, "frame", "chatgpt-subscription"], {
    env: { PATH: process.env.PATH, FLOYD_VAULT_HANDOFF_NO_OPEN: "1" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /native ChatGPT\/Codex subscription management through Floyd Vault/);
  assert.doesNotMatch(result.stdout + result.stderr, /sk-|AIza|ghp_|tvly-|hf_|fm_/);
});

test("native FloydShell --vault opens and focuses the protected management panel", () => {
  const shell = readFileSync(new URL("../apps/frame/native/FloydShell.swift", import.meta.url), "utf8");
  const frame = readFileSync(new URL("../apps/frame/public/index.html", import.meta.url), "utf8");
  assert.match(shell, /CommandLine\.arguments\.contains\("--vault"\)/);
  assert.ok(shell.includes('"http://127.0.0.1:\\(port)/#vault"'));
  assert.match(shell, /X-Floyd-Management-Bootstrap/);
  assert.match(frame, /location\.hash !== "#vault"/);
  assert.match(frame, /keys\.panel\.classList\.add\("open"\)/);
  assert.match(frame, /requestAnimationFrame\(\(\) => el\("keyInput"\)\.focus\(\)\)/);
});

test("FF update-providers preserves model metadata without accepting credential or route changes", () => {
  const ffLaunch = readFileSync(new URL("../intake/surfaces/ff/launch.sh", import.meta.url), "utf8");
  const launcher = readFileSync(new URL("../intake/surfaces/launcher/agents/bin/floyd-agent", import.meta.url), "utf8");
  for (const source of [ffLaunch, launcher]) {
    assert.match(source, /update-providers\)[\s\S]*update-floyd-providers-with-vault\.mjs[\s\S]*"\$@"/);
    assert.doesNotMatch(source, /update-providers\)[\s\S]{0,200}vault-provider-handoff\.mjs/);
  }
  const dir = mkdtempSync(join(tmpdir(), "floyd-provider-update-test-"));
  const managed = join(dir, "managed");
  const profile = join(dir, "profile.json");
  const source = join(dir, "providers.json");
  const beforeStages = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("floyd-provider-update-")));
  try {
    writeFileSync(profile, JSON.stringify({
      app: "ff",
      proxyToken: TOKEN,
      proxyUrl: PROXY,
    }));
    writeFileSync(source, JSON.stringify([{
      id: "anthropic",
      name: "Untrusted Updated Provider",
      api_key: "real-provider-key-must-not-land",
      api_endpoint: "https://api.anthropic.com",
      type: "anthropic",
      default_large_model_id: "vault-update-model",
      default_small_model_id: "vault-update-model",
      models: [{
        id: "vault-update-model",
        name: "Vault Update Model",
        context_window: 123456,
        default_max_tokens: 4096,
        can_reason: true,
      }],
    }]));
    writeFileSync(join(dir, "floyd.json"), JSON.stringify({ unrelated: { preserved: true } }));
    // The managed directory is intentionally created by the same public materializer
    // used by FF before it dispatches update-providers.
    const materialize = spawnSync(process.execPath, [
      new URL("../scripts/materialize-vault-client-config.mjs", import.meta.url).pathname,
      "ff", profile, dir, managed,
    ], { encoding: "utf8" });
    assert.equal(materialize.status, 0, materialize.stderr);

    const result = spawnSync(process.execPath, [
      new URL("../scripts/update-floyd-providers-with-vault.mjs", import.meta.url).pathname,
      "ff",
      profile,
      new URL("../intake/surfaces/ff/bin/floyd-ff-real", import.meta.url).pathname,
      managed,
      "update-providers",
      source,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /provider model metadata updated/);

    const updated = JSON.parse(readFileSync(join(managed, "floyd.json"), "utf8"));
    assert.deepEqual(updated.unrelated, { preserved: true });
    assert.equal(updated.providers.anthropic.models[0].id, "vault-update-model");
    assert.equal(updated.providers.anthropic.models[0].name, "Vault Update Model");
    assert.equal(updated.providers.anthropic.models[0].context_window, 123456);
    for (const provider of Object.values(updated.providers)) {
      assert.equal(provider.api_key, TOKEN);
      assert.equal(new URL(provider.base_url).hostname, "127.0.0.1");
    }
    assert.ok(!JSON.stringify(updated).includes("real-provider-key-must-not-land"));
    assert.ok(!JSON.stringify(updated).includes("api.anthropic.com"));
    const afterStages = readdirSync(tmpdir())
      .filter((name) => name.startsWith("floyd-provider-update-") && !beforeStages.has(name));
    assert.deepEqual(afterStages, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
