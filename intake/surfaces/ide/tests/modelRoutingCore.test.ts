import { describe, expect, it } from 'vitest';
import {
  PROVIDERS,
  SSEDecoder,
  buildUpstreamRequest,
  detectDialect,
  normalizeProviderEvent,
  normalizeUsageMetrics,
} from '@/model-routing';

describe('model routing protocol core', () => {
  it('uses invariant local Vault provider bases', () => {
    expect(PROVIDERS.deepseek.baseUrl).toBe('http://127.0.0.1:13031/p/deepseek');
    expect(PROVIDERS.zai.baseUrl).toBe('http://127.0.0.1:13031/p/zai/api/coding/paas/v4');
  });

  it('routes OpenAI-compatible messages to chat completions', () => {
    const upstream = buildUpstreamRequest(
      { providerId: 'deepseek', baseUrl: 'http://127.0.0.1:13031/p/deepseek/chat/completions', model: 'deepseek-chat', dialect: 'auto' },
      { messages: [{ role: 'system', content: 'Stay precise.' }, { role: 'user', content: 'Review this.' }] },
    );
    expect(upstream).toMatchObject({ dialect: 'openai', url: 'http://127.0.0.1:13031/p/deepseek/chat/completions' });
    expect(upstream.body.messages).toEqual([{ role: 'system', content: 'Stay precise.' }, { role: 'user', content: 'Review this.' }]);
  });

  it('detects Anthropic models and moves system messages to the top level', () => {
    expect(detectDialect({ providerId: 'openrouter', baseUrl: PROVIDERS.openrouter.baseUrl, model: 'claude-sonnet-4-6', dialect: 'auto' })).toBe('anthropic');
    const upstream = buildUpstreamRequest(
      { providerId: 'anthropic', baseUrl: 'http://127.0.0.1:13031/p/anthropic/v1/messages', model: 'claude-sonnet-4-6', dialect: 'auto' },
      { messages: [{ role: 'system', content: 'One' }, { role: 'system', content: 'Two' }, { role: 'user', content: 'Hello' }], maxTokens: 900 },
    );
    expect(upstream.url).toBe('http://127.0.0.1:13031/p/anthropic/v1/messages');
    expect(upstream.headers['anthropic-version']).toBe('2023-06-01');
    expect(upstream.body).toMatchObject({ system: 'One\n\nTwo', messages: [{ role: 'user', content: 'Hello' }], max_tokens: 900 });
  });

  it('allows an explicit dialect override for routed model catalogs', () => {
    expect(detectDialect({ providerId: 'openrouter', baseUrl: PROVIDERS.openrouter.baseUrl, model: 'future-model', dialect: 'anthropic' })).toBe('anthropic');
  });

  it('decodes fragmented SSE and normalizes both vendor event shapes', () => {
    const decoder = new SSEDecoder();
    expect(decoder.push('data: {"choices":[{"delta":{"content":"hel')).toEqual([]);
    const [openAIFrame] = decoder.push('lo"}}]}\r\n\r\n');
    expect(normalizeProviderEvent('openai', openAIFrame)).toEqual([{ type: 'delta', text: 'hello' }]);

    const [anthropicFrame] = decoder.push('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}\n\n');
    expect(normalizeProviderEvent('anthropic', anthropicFrame)).toEqual([{ type: 'delta', text: 'world' }]);
  });

  it('flattens nested provider usage details into numeric unified metrics', () => {
    expect(normalizeProviderEvent('openai', {
      event: 'message',
      data: JSON.stringify({
        choices: [{ delta: {}, finish_reason: null }],
        usage: {
          prompt_tokens: 12,
          prompt_tokens_details: { cached_tokens: 7 },
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      }),
    })).toEqual([{
      type: 'usage',
      usage: {
        prompt_tokens: 12,
        prompt_tokens_details_cached_tokens: 7,
        completion_tokens_details_reasoning_tokens: 3,
      },
    }]);
    expect(normalizeUsageMetrics({ total_tokens: 22, ignored: 'not-a-number', nested: { cached_tokens: 7 } })).toEqual({
      total_tokens: 22,
      nested_cached_tokens: 7,
    });
  });

  it('rejects a direct vendor address instead of silently bypassing Vault', () => {
    expect(() => buildUpstreamRequest(
      { providerId: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4', dialect: 'auto' },
      { messages: [{ role: 'user', content: 'Hello' }] },
    )).toThrow(/local Vault/);
  });
});
