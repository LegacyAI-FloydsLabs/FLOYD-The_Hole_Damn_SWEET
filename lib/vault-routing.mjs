import { VAULT_PROVIDER_CATALOG, VAULT_PROVIDER_IDS } from "./vault-provider-catalog.mjs";

/**
 * One routing contract for every managed Floyd application.
 *
 * Applications receive a durable fv_ capability plus loopback addresses.
 * Vendor credentials and vendor origins are deliberately absent.
 */

export { VAULT_PROVIDER_IDS };

export const PROVIDER_CREDENTIAL_ENV = Object.freeze({
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  huggingface: ["HF_TOKEN", "HUGGINGFACE_HUB_TOKEN"],
  github: ["GITHUB_TOKEN", "GH_TOKEN", "COPILOT_GITHUB_TOKEN"],
  elevenlabs: ["ELEVENLABS_API_KEY"],
  zai: ["GLM_API_KEY", "ZAI_API_KEY", "ZHIPU_API_KEY", "FLOYD_GLM_API_KEY"],
  minimax: ["MINIMAX_API_KEY", "MINIMAX_CODE_API_KEY", "MINIMAX_CODE_CN_API_KEY"],
  moonshot: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
  tavily: ["TAVILY_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  xai: ["XAI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  fal: ["FAL_KEY"],
});

export function normalizeVaultProxyUrl(value) {
  const parsed = new URL(String(value || "").trim());
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("Vault proxy must be an HTTP loopback URL");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Vault proxy URL cannot contain credentials, query, or fragment");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

export function assertVaultToken(token) {
  const value = String(token || "").trim();
  if (!/^fv_[A-Za-z0-9_-]+_[0-9a-f]{32,}$/.test(value)) {
    throw new Error("Managed application credential must be an fv_ Vault capability");
  }
  return value;
}

export function providerProxyUrl(proxy, provider) {
  const normalized = normalizeVaultProxyUrl(proxy);
  const path = VAULT_PROVIDER_CATALOG[provider]?.proxyPath;
  if (!path) throw new Error(`Vault has no managed route for provider ${provider}`);
  return `${normalized}${path}`;
}

export function buildVaultProfile(appId, token, proxy) {
  const proxyToken = assertVaultToken(token);
  const proxyUrl = normalizeVaultProxyUrl(proxy);
  return {
    version: 1,
    app: String(appId),
    proxyUrl,
    proxyToken,
    providerRoutes: Object.fromEntries(
      VAULT_PROVIDER_IDS.map((provider) => [provider, providerProxyUrl(proxyUrl, provider)]),
    ),
  };
}

export function buildVaultEnvironment(appId, token, proxy, inherited = {}) {
  const capability = assertVaultToken(token);
  const base = normalizeVaultProxyUrl(proxy);
  const env = {
    FLOYD_VAULT_APP_ID: String(appId),
    FLOYD_VAULT_PROXY_URL: base,
    FLOYD_VAULT_PROXY_TOKEN: capability,
    FLOYD_VAULT_APP_PROFILE: inherited.FLOYD_VAULT_APP_PROFILE || "",
    CURSEM_CREDENTIAL_PROXY_URL: base,
    CURSEM_CREDENTIAL_PROXY_TOKEN: capability,
    OMP_AUTH_BROKER_URL: `${base}/omf-broker`,
    OMP_AUTH_BROKER_TOKEN: capability,
    OPENAI_BASE_URL: providerProxyUrl(base, "openai"),
    ANTHROPIC_BASE_URL: providerProxyUrl(base, "anthropic"),
    GOOGLE_GENERATIVE_AI_BASE_URL: providerProxyUrl(base, "google"),
    DEEPSEEK_BASE_URL: providerProxyUrl(base, "deepseek"),
    MISTRAL_BASE_URL: providerProxyUrl(base, "mistral"),
    ZAI_BASE_URL: providerProxyUrl(base, "zai"),
    ZHIPUAI_BASE_URL: providerProxyUrl(base, "zai"),
    MOONSHOT_BASE_URL: providerProxyUrl(base, "moonshot"),
    OPENROUTER_BASE_URL: providerProxyUrl(base, "openrouter"),
    XAI_BASE_URL: providerProxyUrl(base, "xai"),
    GROQ_BASE_URL: providerProxyUrl(base, "groq"),
  };
  for (const provider of VAULT_PROVIDER_IDS) {
    env[`FLOYD_VAULT_${provider.toUpperCase()}_BASE_URL`] = providerProxyUrl(base, provider);
    for (const name of PROVIDER_CREDENTIAL_ENV[provider]) env[name] = capability;
  }
  return env;
}

export function applyVaultEnvironment(inherited, appId, token, proxy, profilePath = "") {
  const env = { ...inherited };
  // Remove every credential-like value and address before adding the canonical
  // Vault capability and loopback routes. Unknown providers must not become a
  // second credential authority merely because the parent process exported
  // REAL_SECRET, GITHUB_PAT, GOOGLE_APPLICATION_CREDENTIALS, or similar names.
  for (const name of Object.keys(env)) {
    if (isCredentialEnvironmentName(name) || isProviderAddressEnvironmentName(name)) {
      delete env[name];
    }
  }
  return {
    ...env,
    ...buildVaultEnvironment(appId, token, proxy, { FLOYD_VAULT_APP_PROFILE: profilePath }),
    FLOYD_VAULT_APP_PROFILE: profilePath,
  };
}

export function isCredentialEnvironmentName(name) {
  const normalized = String(name).toUpperCase();
  // Floyd-internal surface configuration — not vendor credentials.
  if (/^TERMINALONE_/.test(normalized)) return false;
  if (/^CURSEM_/.test(normalized) && /ORIGIN$/.test(normalized)) return false;
  // Frame-minted loopback token the IDE uses to attach to the canonical
  // TerminalOne — the same internal-config class as TERMINALONE_AUTH_TOKEN
  // (both sides are minted together in frame-server.mjs). Scrubbing it left
  // the IDE with CURSEM_TERMINAL_URL but no credential, breaking every
  // framed /api/terminal/auth with a 503.
  if (normalized === 'CURSEM_TERMINAL_TOKEN') return false;
  return /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|CREDENTIALS?|PASSWORD|PASS|PASSWD|COOKIE|AUTHORIZATION|PAT)(?:_|$)/.test(normalized)
    || [
      "AWS_ACCESS_KEY_ID",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "AZURE_CLIENT_SECRET",
      "FAL_KEY",
    ].includes(normalized);
}

export function isProviderAddressEnvironmentName(name) {
  const normalized = String(name).toUpperCase();
  return /(?:_BASE_URL|_ENDPOINT|_API_URL)$/.test(normalized)
    || normalized.startsWith("FLOYD_VAULT_")
    || normalized.startsWith("CURSEM_CREDENTIAL_PROXY_")
    || normalized.startsWith("OMP_AUTH_BROKER_");
}

/**
 * Fail closed if copied client state still contains a real credential or a
 * direct built-in provider destination after Vault materialization.
 */
export function assertVaultOnlyClientConfiguration(value, context = "client configuration") {
  const vendorHosts = new Set(
    Object.values(VAULT_PROVIDER_CATALOG)
      .flatMap((provider) => [provider.upstream, provider.openai, provider.anthropic])
      .filter(Boolean)
      .map((url) => new URL(url).hostname),
  );
  const credentialField = /(?:^|[_-])(?:api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|password|passwd|credentials?|cookie|github[_-]?pat)(?:[_-]|$)/i;
  const visit = (entry, path = []) => {
    if (!entry || typeof entry !== "object") return;
    for (const [name, child] of Object.entries(entry)) {
      const nextPath = [...path, name];
      if (credentialField.test(name) && typeof child === "string" && child && !child.startsWith("fv_")) {
        throw new Error(`${context} retains a non-Vault credential at ${nextPath.join(".")}`);
      }
      if (typeof child === "string" && /^https?:\/\//i.test(child)) {
        let parsed;
        try { parsed = new URL(child); } catch { parsed = null; }
        if (parsed && vendorHosts.has(parsed.hostname)) {
          throw new Error(`${context} retains a direct provider destination at ${nextPath.join(".")}`);
        }
      }
      visit(child, nextPath);
    }
  };
  visit(value);
  return value;
}

export function assertVaultOnlyClientText(text, context = "client file") {
  const source = String(text);
  const vendorHosts = [...new Set(Object.values(VAULT_PROVIDER_CATALOG)
    .flatMap((provider) => [provider.upstream, provider.openai, provider.anthropic])
    .filter(Boolean)
    .map((url) => new URL(url).hostname))];
  for (const host of vendorHosts) {
    if (source.includes(host)) {
      throw new Error(`${context} retains a direct provider destination (${host})`);
    }
  }
  const credentialShapes = [
    /sk-ant-api\d{2}-[A-Za-z0-9_-]{40,}/,
    /sk-(?:proj|svcacct)-[A-Za-z0-9_-]{40,}/,
    /AIza[A-Za-z0-9_-]{35}/,
    /(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})/,
    /(?:gsk_|xai-|tvly-|hf_|sk-or-v1-)[A-Za-z0-9_-]{24,}/,
  ];
  if (credentialShapes.some((pattern) => pattern.test(source))) {
    throw new Error(`${context} retains a provider credential`);
  }
  const concreteAssignment = /(?:api[-_.]?key|access[-_.]?token|auth[-_.]?token|client[-_.]?secret|password|credentials?|github[-_.]?pat)\s*[:=]\s*["']([^"']+)["']/ig;
  for (const match of source.matchAll(concreteAssignment)) {
    const value = match[1].trim();
    if (value && !value.startsWith("fv_")
      && !/^(?:\$\{|\{env:|process\.env\.|env\.)/.test(value)) {
      throw new Error(`${context} retains a concrete non-Vault credential assignment`);
    }
  }
  return text;
}

export function buildFloydProviderConfig(token, proxy) {
  const capability = assertVaultToken(token);
  const config = {};
  const add = (ids, provider, type, models) => {
    for (const id of ids) {
      config[id] = {
        id,
        name: `Floyd Vault ${provider}`,
        api_key: capability,
        base_url: providerProxyUrl(proxy, provider),
        type,
        models: models.map((model) => ({ id: model, name: model })),
      };
    }
  };
  add(["openai"], "openai", "openai", ["gpt-5.2-codex"]);
  // The catwalk harness (floyd-ff) refuses to start unless its default
  // anthropic model IDs exist in the provider's model list, even when the
  // active model is another provider entirely. Keep them as metadata-only
  // entries; requests still route through the Vault proxy.
  add(["anthropic"], "anthropic", "anthropic", [
    "claude-sonnet-4-6",
    "claude-sonnet-4-5-20250929",
    "claude-3-5-haiku-20241022",
  ]);
  add(["google"], "google", "gemini", ["gemini-2.5-pro"]);
  add(["deepseek"], "deepseek", "openai", ["deepseek-chat"]);
  add(["mistral"], "mistral", "openai", ["mistral-large-latest", "codestral-latest"]);
  add(["huggingface"], "huggingface", "openai", ["Qwen/Qwen3-Coder-480B-A35B-Instruct"]);
  add(["zai"], "zai", "openai", ["glm-4.7"]);
  add(["minimax"], "minimax", "anthropic", ["MiniMax-M3"]);
  add(["moonshot"], "moonshot", "openai", ["kimi-k2.5"]);
  add(["openrouter"], "openrouter", "openai", ["openai/gpt-4o"]);
  add(["xai"], "xai", "openai", ["grok-4"]);
  add(["groq"], "groq", "openai", ["llama-3.3-70b-versatile"]);
  return config;
}

/**
 * The set of providers that currently hold a Vault key, learned from the
 * credential proxy (`GET /status`). `openai` is included only when the
 * ChatGPT subscription is configured. Returns null when the status route is
 * unreachable, in which case callers keep every provider so a launch can
 * never break on a missing or stale status route.
 */
export async function fetchVaultKeyedProviders(token, proxy, { fetchImpl, timeoutMs } = {}) {
  const fetcher = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
  if (typeof fetcher !== "function") return null;
  try {
    const response = await fetcher(`${normalizeVaultProxyUrl(proxy)}/status`, {
      headers: { authorization: `Bearer ${assertVaultToken(token)}` },
      signal: AbortSignal.timeout(timeoutMs ?? 4000),
    });
    if (!response.ok) throw new Error(`Vault status route returned HTTP ${response.status}`);
    const payload = await response.json();
    const keyed = new Set(
      (Array.isArray(payload?.configuredProviders) ? payload.configuredProviders : [])
        .map((id) => String(id))
        .filter((id) => VAULT_PROVIDER_IDS.includes(id)),
    );
    if (payload?.subscriptionConfigured === true) keyed.add("openai");
    return keyed;
  } catch {
    return null;
  }
}

function keyedOnly(config, keyedProviders) {
  if (!keyedProviders) return config;
  return Object.fromEntries(Object.entries(config).filter(([id]) => keyedProviders.has(id)));
}

/**
 * Live variant of buildFloydProviderConfig. Asks the Vault credential proxy
 * for the current model lists (`GET /models`, Bearer capability) and merges
 * them over the static catalog. Any failure keeps the static entries so the
 * ff launch path can never break on a missing or stale model route. When
 * `keyedProviders` (a Set from fetchVaultKeyedProviders) is given, providers
 * without a Vault key are dropped from the result.
 */
export async function buildFloydProviderConfigLive(token, proxy, { fetchImpl, timeoutMs, keyedProviders } = {}) {
  const fallback = buildFloydProviderConfig(token, proxy);
  const fetcher = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
  if (typeof fetcher !== "function") return keyedOnly(fallback, keyedProviders);
  let payload;
  try {
    const response = await fetcher(`${normalizeVaultProxyUrl(proxy)}/models`, {
      headers: { authorization: `Bearer ${assertVaultToken(token)}` },
      signal: AbortSignal.timeout(timeoutMs ?? 4000),
    });
    if (!response.ok) throw new Error(`Vault model route returned HTTP ${response.status}`);
    payload = await response.json();
  } catch {
    return keyedOnly(fallback, keyedProviders);
  }
  const live = liveModelLists(payload);
  for (const [id, entry] of Object.entries(fallback)) {
    if (id === "openai") continue; // ChatGPT subscription has no list endpoint.
    const models = live.get(id);
    if (!models?.length) continue;
    // The pinned anthropic IDs keep the catwalk harness (floyd-ff) bootable;
    // live anthropic models merge after them, de-duplicated by id.
    const merged = id === "anthropic" ? [...entry.models] : [];
    const seen = new Set(merged.map((model) => model.id));
    for (const model of models) {
      const modelId = String(model?.id || "").trim();
      if (!modelId || seen.has(modelId)) continue;
      seen.add(modelId);
      merged.push({ id: modelId, name: String(model.name || modelId) });
    }
    if (merged.length) entry.models = merged;
  }
  return keyedOnly(fallback, keyedProviders);
}

function liveModelLists(payload) {
  const lists = new Map();
  const record = (provider, models) => {
    if (provider && Array.isArray(models)) lists.set(String(provider), models);
  };
  const providers = payload && typeof payload === "object" ? payload.providers ?? payload : null;
  if (Array.isArray(providers)) {
    for (const entry of providers) record(entry?.provider ?? entry?.id, entry?.models);
  } else if (providers && typeof providers === "object") {
    for (const [provider, entry] of Object.entries(providers)) {
      if (Array.isArray(entry)) record(provider, entry);
      else record(entry?.provider ?? provider, entry?.models);
    }
  }
  return lists;
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

/**
 * GLM tier picks from the zai model list (`config.providers.zai.models`).
 * The proxy currently returns the list oldest-first, so the "top" pick is
 * the highest glm version in the list (glm-5.2 today); the fast tier is the
 * entry containing "air", else the first entry. Returns null when the list
 * is empty.
 */
export function resolveZaiModelTiers(models) {
  const ids = (Array.isArray(models) ? models : [])
    .map((model) => String(model?.id ?? model ?? "").trim())
    .filter(Boolean);
  if (!ids.length) return null;
  let large = ids[ids.length - 1];
  let best = null;
  for (const id of ids) {
    const match = id.match(/(\d+(?:\.\d+)+)/);
    if (!match) continue;
    const parsed = match[1].split(".").map(Number);
    if (!best || compareVersions(parsed, best) > 0) {
      best = parsed;
      large = id;
    }
  }
  const small = ids.find((id) => id.toLowerCase().includes("air")) ?? ids[0];
  return { large, small };
}

/**
 * Floyd model policy for managed client configs (D1/D2): seed models.large
 * and models.small from the live zai tiers, preserving an existing pick
 * while its provider still holds a Vault key. A stale pick keeps its extra
 * fields (reasoning_effort, max_tokens, ...) and only re-seeds model and
 * provider. recent_models entries whose provider lost its key are dropped.
 * A null keyedProviders (status route unreachable) preserves everything.
 */
export function applyFloydModelPolicy(config, keyedProviders) {
  if (!config || typeof config !== "object") return config;
  const keyed = (provider) => !keyedProviders || keyedProviders.has(provider);
  const tiers = resolveZaiModelTiers(config.providers?.zai?.models);
  const models = config.models && typeof config.models === "object" ? config.models : {};
  config.models = models;
  if (tiers && keyed("zai")) {
    for (const [slot, pick] of [["large", tiers.large], ["small", tiers.small]]) {
      const existing = models[slot];
      if (existing && typeof existing === "object" && keyed(String(existing.provider || ""))) continue;
      models[slot] = {
        ...(existing && typeof existing === "object" ? existing : {}),
        model: pick,
        provider: "zai",
      };
    }
  }
  if (Array.isArray(config.recent_models)) {
    config.recent_models = config.recent_models.filter((entry) => !entry
      || typeof entry !== "object"
      || !entry.provider
      || keyed(String(entry.provider)));
  }
  return config;
}

export function buildOmpProviderConfig(token, proxy, keyedProviders = null) {
  const capability = assertVaultToken(token);
  const providers = {};
  const add = (ids, provider) => {
    if (keyedProviders && !keyedProviders.has(provider)) return;
    for (const id of ids) providers[id] = { apiKey: capability, baseUrl: providerProxyUrl(proxy, provider) };
  };
  add(["openai"], "openai");
  add(["anthropic"], "anthropic");
  add(["google"], "google");
  add(["deepseek"], "deepseek");
  add(["mistral"], "mistral");
  add(["huggingface"], "huggingface");
  add(["zai", "zhipu-coding-plan"], "zai");
  add(["minimax", "minimax-cn", "minimax-code", "minimax-code-cn"], "minimax");
  add(["moonshot"], "moonshot");
  add(["openrouter"], "openrouter");
  add(["xai"], "xai");
  add(["groq"], "groq");
  return providers;
}

export function buildOpenCodeProviderConfig(token, proxy) {
  return {
    options: {
      apiKey: assertVaultToken(token),
      baseURL: providerProxyUrl(proxy, "zai"),
    },
  };
}

export function readVaultAppProfile(raw, expectedApp) {
  const profile = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!profile || typeof profile !== "object") throw new Error("Vault application profile is missing");
  if (expectedApp && profile.app !== expectedApp) throw new Error(`Vault application profile is not for ${expectedApp}`);
  return {
    app: String(profile.app),
    token: assertVaultToken(profile.proxyToken || profile.token),
    proxy: normalizeVaultProxyUrl(profile.proxyUrl || profile.proxy),
    providerRoutes: profile.providerRoutes && typeof profile.providerRoutes === "object"
      ? { ...profile.providerRoutes }
      : Object.fromEntries(
        VAULT_PROVIDER_IDS.map((provider) => [
          provider,
          providerProxyUrl(profile.proxyUrl || profile.proxy, provider),
        ]),
      ),
  };
}
