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

export function buildOmpProviderConfig(token, proxy) {
  const capability = assertVaultToken(token);
  const providers = {};
  const add = (ids, provider) => {
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
