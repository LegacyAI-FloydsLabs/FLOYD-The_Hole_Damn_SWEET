import { describe, expect, it, vi } from 'vitest';
import {
  STATIC_PROVIDER_MODELS,
  fetchVaultModelList,
  resolveBootProviderModel,
  resolveDesktopProviderModels,
  resolveGlmSeedModel,
  vaultModelListProviderId,
} from './live-models.js';

const TOKEN = `fv_desktop_${'1'.repeat(48)}`;
const VAULT = 'http://127.0.0.1:13031';

describe('Desktop live provider model lists', () => {
  it('serves the live list from the Vault proxy with the fv_ bearer token', async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      provider: 'anthropic',
      source: 'live',
      fetchedAt: '2026-07-31T23:00:00-04:00',
      models: [
        { id: 'claude-live-1', name: 'Claude Live 1' },
        { id: 'claude-live-2', name: 'Claude Live 2' },
      ],
    })) as unknown as typeof globalThis.fetch;

    const models = await fetchVaultModelList({
      vaultUrl: VAULT,
      vaultToken: TOKEN,
      provider: 'anthropic',
      fetchImpl,
    });

    expect(models).toEqual([
      { id: 'claude-live-1', name: 'Claude Live 1' },
      { id: 'claude-live-2', name: 'Claude Live 2' },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:13031/models/anthropic',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }),
      }),
    );
  });

  it('maps GLM to the zai Vault route and never queries providers without a list route', async () => {
    expect(vaultModelListProviderId('anthropic')).toBe('anthropic');
    expect(vaultModelListProviderId('openai')).toBe('openai');
    expect(vaultModelListProviderId('glm')).toBe('zai');
    expect(vaultModelListProviderId('chatgpt-subscription')).toBeNull();
    expect(vaultModelListProviderId('anthropic-compatible')).toBeNull();

    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    expect(await fetchVaultModelList({
      vaultUrl: VAULT,
      vaultToken: TOKEN,
      provider: 'chatgpt-subscription',
      fetchImpl,
    })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back to the static list per provider on any fetch failure', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/models/anthropic')) {
        return Response.json({ models: [{ id: 'claude-live-1', name: 'Claude Live 1' }] });
      }
      if (url.endsWith('/models/openai')) {
        return new Response('vault has no key', { status: 503 });
      }
      throw new Error('connection refused');
    }) as unknown as typeof globalThis.fetch;

    const { models, sources } = await resolveDesktopProviderModels({
      vaultUrl: VAULT,
      vaultToken: TOKEN,
      fetchImpl,
    });

    expect(models.anthropic).toEqual([{ id: 'claude-live-1', name: 'Claude Live 1' }]);
    expect(sources.anthropic).toBe('live');

    expect(models.openai).toEqual(STATIC_PROVIDER_MODELS.openai);
    expect(sources.openai).toBe('fallback');

    expect(models.glm).toEqual(STATIC_PROVIDER_MODELS.glm);
    expect(sources.glm).toBe('fallback');

    expect(models['chatgpt-subscription']).toEqual(STATIC_PROVIDER_MODELS['chatgpt-subscription']);
    expect(sources['chatgpt-subscription']).toBe('fallback');
    expect(sources['anthropic-compatible']).toBe('fallback');
  });

  it('treats malformed Vault payloads as unavailable', async () => {
    const bodies = [
      'not json',
      JSON.stringify({}),
      JSON.stringify({ models: 'nope' }),
      JSON.stringify({ models: [] }),
      JSON.stringify({ models: [{ name: 'no id' }] }),
    ];
    for (const body of bodies) {
      const fetchImpl = vi.fn(async () => new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch;
      expect(await fetchVaultModelList({
        vaultUrl: VAULT,
        vaultToken: TOKEN,
        provider: 'openai',
        fetchImpl,
      })).toBeNull();
    }
  });

  it('keeps the fallback lists free of custom-model pseudo-entries', () => {
    for (const list of Object.values(STATIC_PROVIDER_MODELS)) {
      expect(list.length).toBeGreaterThan(0);
      expect(list.some((entry) => entry.id === 'custom-model')).toBe(false);
    }
  });
});

describe('GLM default route boot seeding', () => {
  it('seeds the first-run default from the live zai model list', async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      provider: 'zai',
      source: 'live',
      models: [{ id: 'glm-live-first', name: 'GLM Live First' }],
    })) as unknown as typeof globalThis.fetch;

    const seed = await resolveGlmSeedModel({ vaultUrl: VAULT, vaultToken: TOKEN, fetchImpl });

    expect(seed).toBe('glm-live-first');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:13031/models/zai',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }),
      }),
    );

    const boot = resolveBootProviderModel({
      savedProvider: null,
      savedModel: null,
      savedProviderReady: null,
      glmSeedModel: seed,
    });
    expect(boot).toEqual({ provider: 'glm', model: 'glm-live-first', persist: false });
  });

  it('seeds from the static GLM list when the Vault is unreachable at boot', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connection refused');
    }) as unknown as typeof globalThis.fetch;

    const seed = await resolveGlmSeedModel({ vaultUrl: VAULT, vaultToken: TOKEN, fetchImpl });
    expect(seed).toBe(STATIC_PROVIDER_MODELS.glm[0].id);
  });

  it('re-seeds to GLM and persists when the saved provider lost its Vault key', () => {
    const boot = resolveBootProviderModel({
      savedProvider: 'anthropic',
      savedModel: 'claude-sonnet-4-5-20250514',
      savedProviderReady: false,
      glmSeedModel: 'glm-live-first',
    });
    expect(boot).toEqual({ provider: 'glm', model: 'glm-live-first', persist: true });
  });

  it('keeps saved settings when the provider is ready or readiness is unknown', () => {
    for (const savedProviderReady of [true, null] as const) {
      const boot = resolveBootProviderModel({
        savedProvider: 'openai',
        savedModel: 'gpt-4o',
        savedProviderReady,
        glmSeedModel: 'glm-live-first',
      });
      expect(boot).toEqual({ provider: 'openai', model: 'gpt-4o', persist: false });
    }
  });
});
