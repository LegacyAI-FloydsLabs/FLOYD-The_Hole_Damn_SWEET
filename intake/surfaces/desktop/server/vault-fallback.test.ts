import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureVaultFallback, readVaultFallback } from './vault-fallback.js';

describe('Vault GLM-fallback marker headers', () => {
  it('reads the failed provider and actual serving model', () => {
    const headers = new Headers({
      'x-floyd-fallback': 'deepseek',
      'x-floyd-fallback-model': 'glm-5.2',
    });
    expect(readVaultFallback(headers)).toEqual({ provider: 'deepseek', model: 'glm-5.2' });
  });

  it('tolerates a missing model header and blank values', () => {
    expect(readVaultFallback(new Headers({ 'x-floyd-fallback': 'deepseek' })))
      .toEqual({ provider: 'deepseek', model: null });
    expect(readVaultFallback(new Headers({ 'x-floyd-fallback': '  ' }))).toBeNull();
    expect(readVaultFallback(new Headers())).toBeNull();
  });

  it('captures the notice from SDK traffic and keeps it sticky across later direct responses', async () => {
    const upstream = vi.fn()
      .mockResolvedValueOnce(new Response('{}', {
        status: 200,
        headers: { 'x-floyd-fallback': 'openai', 'x-floyd-fallback-model': 'glm-5.2' },
      }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', upstream);

    const cap = captureVaultFallback();
    expect(cap.notice()).toBeNull();

    const first = await cap.fetch('http://127.0.0.1:13031/p/openai/v1/chat/completions', { method: 'POST' });
    expect(first.status).toBe(200);
    expect(cap.notice()).toEqual({ provider: 'openai', model: 'glm-5.2' });

    await cap.fetch('http://127.0.0.1:13031/p/openai/v1/chat/completions', { method: 'POST' });
    expect(cap.notice()).toEqual({ provider: 'openai', model: 'glm-5.2' });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('reports null when upstream answers directly without the marker', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const cap = captureVaultFallback();
    await cap.fetch('http://127.0.0.1:13031/p/anthropic/v1/messages', { method: 'POST' });
    expect(cap.notice()).toBeNull();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});
