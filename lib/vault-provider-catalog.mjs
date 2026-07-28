/**
 * Single provider catalog for Floyd Vault.
 *
 * The catalog is safe to publish: it contains routing metadata, never
 * credentials. Server-only code uses `upstream` and `auth`; applications see
 * only `proxyPath`, protocols, capabilities, and representative models.
 */
export const VAULT_PROVIDER_CATALOG = Object.freeze({
  openai: Object.freeze({
    id: "openai", name: "OpenAI (ChatGPT subscription)", protocol: "responses",
    proxyPath: "/v1", upstream: null, auth: "subscription",
    models: ["gpt-5.2-codex"], capabilities: ["responses", "chat", "streaming", "tools", "images"],
  }),
  anthropic: Object.freeze({
    id: "anthropic", name: "Anthropic", protocol: "anthropic",
    proxyPath: "/p/anthropic", upstream: "https://api.anthropic.com",
    anthropic: "https://api.anthropic.com/v1/messages", auth: "anthropic",
    models: ["claude-sonnet-4-6"], capabilities: ["chat", "streaming", "tools", "attachments"],
  }),
  google: Object.freeze({
    id: "google", name: "Google Gemini", protocol: "google",
    proxyPath: "/p/google/v1beta", upstream: "https://generativelanguage.googleapis.com",
    auth: "google", models: ["gemini-2.5-pro"], capabilities: ["chat", "streaming", "tools", "attachments", "images"],
  }),
  deepseek: Object.freeze({
    id: "deepseek", name: "DeepSeek", protocol: "openai",
    proxyPath: "/p/deepseek", upstream: "https://api.deepseek.com",
    openai: "https://api.deepseek.com/chat/completions", auth: "bearer",
    models: ["deepseek-chat"], capabilities: ["chat", "streaming", "tools"],
  }),
  mistral: Object.freeze({
    id: "mistral", name: "Mistral", protocol: "openai",
    proxyPath: "/p/mistral/v1", upstream: "https://api.mistral.ai",
    openai: "https://api.mistral.ai/v1/chat/completions", auth: "bearer",
    models: ["mistral-large-latest"], capabilities: ["chat", "streaming", "tools", "attachments"],
  }),
  huggingface: Object.freeze({
    id: "huggingface", name: "Hugging Face", protocol: "openai",
    proxyPath: "/p/huggingface/v1", upstream: "https://router.huggingface.co",
    openai: "https://router.huggingface.co/v1/chat/completions", auth: "bearer",
    models: [], capabilities: ["chat", "streaming", "inference"],
  }),
  github: Object.freeze({
    id: "github", name: "GitHub", protocol: "native",
    proxyPath: "/p/github", upstream: "https://api.github.com", auth: "github",
    models: [], capabilities: ["rest", "uploads"],
  }),
  elevenlabs: Object.freeze({
    id: "elevenlabs", name: "ElevenLabs", protocol: "native",
    proxyPath: "/p/elevenlabs", upstream: "https://api.elevenlabs.io", auth: "elevenlabs",
    models: [], capabilities: ["audio", "streaming", "voices"],
  }),
  zai: Object.freeze({
    id: "zai", name: "Z.ai GLM Coding", protocol: "openai+anthropic",
    proxyPath: "/p/zai/api/coding/paas/v4", upstream: "https://api.z.ai",
    openai: "https://api.z.ai/api/coding/paas/v4/chat/completions",
    anthropic: "https://api.z.ai/api/anthropic/v1/messages", auth: "bearer",
    models: ["glm-4.7"], capabilities: ["chat", "streaming", "tools"],
  }),
  minimax: Object.freeze({
    id: "minimax", name: "MiniMax Coding Plan", protocol: "anthropic",
    proxyPath: "/p/minimax/anthropic/v1", upstream: "https://api.minimax.io",
    anthropic: "https://api.minimax.io/anthropic/v1/messages", auth: "bearer",
    models: ["MiniMax-M3"], capabilities: ["chat", "streaming", "tools"],
  }),
  moonshot: Object.freeze({
    id: "moonshot", name: "Kimi (Moonshot)", protocol: "openai",
    proxyPath: "/p/moonshot/v1", upstream: "https://api.moonshot.ai",
    openai: "https://api.moonshot.ai/v1/chat/completions", auth: "bearer",
    models: ["kimi-k2.5"], capabilities: ["chat", "streaming", "tools"], requestAdjustments: ["temperature=1"],
  }),
  tavily: Object.freeze({
    id: "tavily", name: "Tavily Search", protocol: "native",
    proxyPath: "/p/tavily", upstream: "https://api.tavily.com", auth: "bearer",
    models: [], capabilities: ["search", "extract", "crawl"],
  }),
  openrouter: Object.freeze({
    id: "openrouter", name: "OpenRouter", protocol: "openai",
    proxyPath: "/p/openrouter/v1", upstream: "https://openrouter.ai/api",
    openai: "https://openrouter.ai/api/v1/chat/completions", auth: "bearer",
    models: [], capabilities: ["chat", "streaming", "tools", "images"],
  }),
  xai: Object.freeze({
    id: "xai", name: "xAI", protocol: "openai",
    proxyPath: "/p/xai/v1", upstream: "https://api.x.ai",
    openai: "https://api.x.ai/v1/chat/completions", auth: "bearer",
    models: ["grok-4"], capabilities: ["chat", "streaming", "tools", "images"],
  }),
  groq: Object.freeze({
    id: "groq", name: "Groq", protocol: "openai",
    proxyPath: "/p/groq/openai/v1", upstream: "https://api.groq.com",
    openai: "https://api.groq.com/openai/v1/chat/completions", auth: "bearer",
    models: [], capabilities: ["chat", "streaming", "tools", "audio"],
  }),
  fal: Object.freeze({
    id: "fal", name: "fal.ai", protocol: "native",
    proxyPath: "/p/fal", upstream: "https://fal.run", auth: "fal",
    models: [], capabilities: ["images", "video", "audio", "queue", "streaming"],
  }),
});

export const VAULT_PROVIDER_IDS = Object.freeze(Object.keys(VAULT_PROVIDER_CATALOG));

export function publicProviderCatalog(routeStatus = {}) {
  return VAULT_PROVIDER_IDS.map((id) => {
    const provider = VAULT_PROVIDER_CATALOG[id];
    return {
      id,
      name: provider.name,
      protocol: provider.protocol,
      proxyPath: provider.proxyPath,
      models: provider.models,
      capabilities: provider.capabilities,
      requestAdjustments: provider.requestAdjustments || [],
      ...routeStatus[id],
    };
  });
}
