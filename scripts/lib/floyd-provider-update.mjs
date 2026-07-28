import {
  chmodSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  assertVaultOnlyClientConfiguration,
  buildFloydProviderConfig,
} from "../../lib/vault-routing.mjs";

const CATALOG_IDS = Object.freeze({
  openai: ["openai"],
  anthropic: ["anthropic"],
  google: ["gemini"],
  deepseek: ["deepseek"],
  mistral: ["mistral"],
  huggingface: ["huggingface"],
  zai: ["zai", "zhipu-coding", "zhipu"],
  minimax: ["minimax", "minimax-china"],
  moonshot: ["moonshot", "kimi-coding"],
  openrouter: ["openrouter"],
  xai: ["xai"],
  groq: ["groq"],
});

const SAFE_MODEL_FIELDS = Object.freeze([
  "id",
  "name",
  "cost_per_1m_in",
  "cost_per_1m_out",
  "cost_per_1m_in_cached",
  "cost_per_1m_out_cached",
  "context_window",
  "default_max_tokens",
  "can_reason",
  "reasoning_levels",
  "default_reasoning_effort",
  "supports_attachments",
]);

function safeModelMetadata(model) {
  if (!model || typeof model !== "object" || typeof model.id !== "string") return null;
  return Object.fromEntries(
    SAFE_MODEL_FIELDS
      .filter((field) => Object.hasOwn(model, field))
      .map((field) => [field, structuredClone(model[field])]),
  );
}

export function mergeUpdatedFloydProviderMetadata(currentConfig, catalog, token, proxy) {
  if (!Array.isArray(catalog)) throw new Error("FF provider update did not produce a provider catalog");
  const next = structuredClone(currentConfig && typeof currentConfig === "object" ? currentConfig : {});
  const vaultProviders = buildFloydProviderConfig(token, proxy);
  const byId = new Map(catalog.filter((provider) => provider && typeof provider.id === "string")
    .map((provider) => [provider.id, provider]));

  for (const [providerId, configured] of Object.entries(vaultProviders)) {
    const updated = (CATALOG_IDS[providerId] || []).map((id) => byId.get(id)).find(Boolean);
    if (!updated) continue;
    const models = Array.isArray(updated.models)
      ? updated.models.map(safeModelMetadata).filter(Boolean)
      : [];
    if (models.length > 0) configured.models = models;
    for (const field of ["default_large_model_id", "default_small_model_id"]) {
      if (typeof updated[field] === "string" && updated[field]) configured[field] = updated[field];
    }
  }

  next.providers = vaultProviders;
  next.options = {
    ...(next.options && typeof next.options === "object" ? next.options : {}),
    disable_default_providers: true,
    disable_provider_auto_update: true,
  };
  return assertVaultOnlyClientConfiguration(next, "FF updated provider configuration");
}

export function writeUpdatedFloydConfig(managedDir, config) {
  const output = join(managedDir, "floyd.json");
  const temporary = `${output}.provider-update-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, output);
  chmodSync(output, 0o600);
}

export function readFloydConfig(managedDir) {
  return JSON.parse(readFileSync(join(managedDir, "floyd.json"), "utf8"));
}
