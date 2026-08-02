/**
 * Live provider model lists via the Vault credential proxy.
 *
 * The Vault holds the real provider keys; Desktop asks its loopback proxy for
 * each provider's current model catalog using only its fv_ capability token
 * (GET /models/<providerId>, Bearer auth). The static lists below are kept
 * strictly as an offline fallback so the settings UI still renders when the
 * Vault or a provider is unreachable.
 */

import { CHATGPT_MODELS } from './chatgpt-subscription.js';

export type DesktopChatProvider = 'chatgpt-subscription' | 'anthropic' | 'openai' | 'glm' | 'anthropic-compatible';

export type ProviderModelEntry = { id: string; name: string };
export type ModelListSource = 'live' | 'fallback';

// Offline fallback lists. No `custom-model` pseudo-entry: model choice must
// always come from a real provider catalog, never typed by hand.
export const STATIC_PROVIDER_MODELS: Record<DesktopChatProvider, ProviderModelEntry[]> = {
  'chatgpt-subscription': CHATGPT_MODELS,
  anthropic: [
    { id: 'claude-sonnet-4-5-20250514', name: 'Claude 4.5 Sonnet (Recommended)' },
    { id: 'claude-opus-4-5-20250514', name: 'Claude 4.5 Opus (Most Capable)' },
    { id: 'claude-sonnet-4-20250514', name: 'Claude 4 Sonnet' },
    { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku (Fast)' },
  ],
  'anthropic-compatible': [
    { id: 'glm-4.7', name: 'GLM-4.7 (Standard, Complex Tasks)' },
    { id: 'glm-4.5-air', name: 'GLM-4.5 Air (Lightweight, Faster)' },
    { id: 'glm-4-plus', name: 'GLM-4 Plus (Most Capable)' },
    { id: 'glm-4-0520', name: 'GLM-4-0520 (Recommended)' },
    { id: 'glm-4', name: 'GLM-4 (Standard)' },
    { id: 'glm-4-air', name: 'GLM-4 Air (Fast)' },
    { id: 'glm-4-airx', name: 'GLM-4 AirX (Faster)' },
    { id: 'glm-4-long', name: 'GLM-4 Long (128K Context)' },
    { id: 'glm-4-flash', name: 'GLM-4 Flash (Cheapest)' },
    { id: 'claude-sonnet-4-5-20250514', name: 'Claude 4.5 Sonnet' },
    { id: 'claude-opus-4-5-20250514', name: 'Claude 4.5 Opus' },
    { id: 'claude-sonnet-4-20250514', name: 'Claude 4 Sonnet' },
    { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
  ],
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o (Recommended)' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini (Fast & Cheap)' },
    { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
    { id: 'gpt-4', name: 'GPT-4' },
    { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo (Cheapest)' },
  ],
  glm: [
    { id: 'glm-4-plus', name: 'GLM-4 Plus (Most Capable)' },
    { id: 'glm-4-0520', name: 'GLM-4-0520 (Recommended)' },
    { id: 'glm-4', name: 'GLM-4 (Standard)' },
    { id: 'glm-4-air', name: 'GLM-4 Air (Fast)' },
    { id: 'glm-4-airx', name: 'GLM-4 AirX (Faster)' },
    { id: 'glm-4-long', name: 'GLM-4 Long (128K Context)' },
    { id: 'glm-4-flash', name: 'GLM-4 Flash (Cheapest)' },
  ],
};

/**
 * Vault /models/<providerId> route id for a Desktop provider, or null when the
 * provider has no list route (ChatGPT subscription, custom-endpoint connectors).
 */
export function vaultModelListProviderId(provider: DesktopChatProvider): string | null {
  if (provider === 'anthropic') return 'anthropic';
  if (provider === 'openai') return 'openai';
  if (provider === 'glm') return 'zai';
  return null;
}

type FetchModelListOptions = Readonly<{
  vaultUrl: string;
  vaultToken: string;
  provider: DesktopChatProvider;
  fetchImpl?: typeof globalThis.fetch;
}>;

/**
 * Fetch one provider's live model list from the Vault proxy. Never throws:
 * any failure (no route, no Vault key, network, bad payload) returns null so
 * the caller can fall back to the static list.
 */
export async function fetchVaultModelList(options: FetchModelListOptions): Promise<ProviderModelEntry[] | null> {
  const providerId = vaultModelListProviderId(options.provider);
  if (!providerId || !options.vaultUrl || !/^fv_/.test(options.vaultToken)) return null;
  try {
    const response = await (options.fetchImpl ?? globalThis.fetch)(
      `${options.vaultUrl}/models/${encodeURIComponent(providerId)}`,
      {
        method: 'GET',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${options.vaultToken}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(4000),
      },
    );
    if (!response.ok) return null;
    const payload: unknown = await response.json().catch(() => null);
    const models = payload && typeof payload === 'object'
      ? (payload as { models?: unknown }).models
      : null;
    if (!Array.isArray(models)) return null;
    const entries = models
      .filter((entry): entry is { id: string; name?: unknown } =>
        Boolean(entry) && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string')
      .map((entry) => ({
        id: entry.id,
        name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : entry.id,
      }));
    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
}

/**
 * Resolve every provider's model list: live from the Vault when possible,
 * static fallback otherwise. `sources` records which path each list took so
 * the UI can show freshness.
 */
export async function resolveDesktopProviderModels(options: Readonly<{
  vaultUrl: string;
  vaultToken: string;
  fetchImpl?: typeof globalThis.fetch;
}>): Promise<{
  models: Record<DesktopChatProvider, ProviderModelEntry[]>;
  sources: Record<DesktopChatProvider, ModelListSource>;
}> {
  const providers = Object.keys(STATIC_PROVIDER_MODELS) as DesktopChatProvider[];
  const liveLists = await Promise.all(providers.map((provider) =>
    fetchVaultModelList({ ...options, provider })));
  const models = {} as Record<DesktopChatProvider, ProviderModelEntry[]>;
  const sources = {} as Record<DesktopChatProvider, ModelListSource>;
  providers.forEach((provider, index) => {
    const live = liveLists[index];
    models[provider] = live ?? STATIC_PROVIDER_MODELS[provider];
    sources[provider] = live ? 'live' : 'fallback';
  });
  return { models, sources };
}

/**
 * Seed model for the GLM (zai) default route: first entry of the live Vault
 * model list when reachable, first entry of the static fallback otherwise.
 */
export async function resolveGlmSeedModel(options: Readonly<{
  vaultUrl: string;
  vaultToken: string;
  fetchImpl?: typeof globalThis.fetch;
}>): Promise<string> {
  const live = await fetchVaultModelList({ ...options, provider: 'glm' });
  return live?.[0]?.id ?? STATIC_PROVIDER_MODELS.glm[0].id;
}

/**
 * Decide the boot-time provider/model. GLM (zai) is the locked ecosystem
 * default route: with no saved settings the first run seeds GLM. Saved
 * settings are kept untouched unless their provider has lost its Vault key
 * (readiness explicitly false), in which case they are re-seeded to GLM and
 * the caller must persist (`persist: true`). When readiness is unknown
 * (Vault unreachable at boot), saved settings are kept — an unreachable
 * Vault is not proof a key is gone.
 */
export function resolveBootProviderModel(input: Readonly<{
  savedProvider: DesktopChatProvider | null;
  savedModel: string | null;
  savedProviderReady: boolean | null;
  glmSeedModel: string;
}>): Readonly<{ provider: DesktopChatProvider; model: string; persist: boolean }> {
  if (!input.savedProvider || !input.savedModel) {
    return { provider: 'glm', model: input.glmSeedModel, persist: false };
  }
  if (input.savedProviderReady === false) {
    return { provider: 'glm', model: input.glmSeedModel, persist: true };
  }
  return { provider: input.savedProvider, model: input.savedModel, persist: false };
}
