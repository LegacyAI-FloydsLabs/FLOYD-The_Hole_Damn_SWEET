import { describe, expect, it } from 'vitest';
import { PolicyModelClient, ProviderHttpError, subscribeRoutingDecisions, type RoutingDecision } from '../src/model-routing';
import type { ConversationRequest, UnifiedEvent } from '../src/model-routing/core.mjs';

const request: ConversationRequest = { messages: [{ role: 'user', content: 'hello' }] };
const active = {
  providerId: 'anthropic' as const,
  baseUrl: 'https://api.anthropic.com/v1',
  model: 'claude-sonnet-4-6',
  dialect: 'anthropic' as const,
  apiKey: '',
  credentialMode: 'host' as const,
};

async function collect(stream: AsyncGenerator<UnifiedEvent>): Promise<UnifiedEvent[]> {
  const events: UnifiedEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('policy model routing', () => {
  it('chooses OpenCode Go first for host-managed low-cost routing', async () => {
    const attempted: string[] = [];
    const transport = { stream: async function* (config: typeof active) {
      attempted.push(config.providerId);
      yield { type: 'done', finishReason: 'stop' } as UnifiedEvent;
    } };
    const client = new PolicyModelClient(transport as never);
    await collect(client.stream({ ...active, routingPolicy: 'cost-first' }, request));
    expect(attempted).toEqual(['opencode-go']);
  });

  it('falls back on retryable pre-output failures and reports the decision', async () => {
    const attempted: string[] = [];
    const decisions: RoutingDecision[] = [];
    const unsubscribe = subscribeRoutingDecisions((decision) => decisions.push(decision));
    const transport = { stream: async function* (config: typeof active) {
      attempted.push(config.providerId);
      if (attempted.length === 1) throw new ProviderHttpError(429, 'Too Many Requests', '{"error":{"message":"rate limited"}}');
      yield { type: 'delta', text: 'ok' } as UnifiedEvent;
      yield { type: 'done', finishReason: 'stop' } as UnifiedEvent;
    } };
    try {
      const client = new PolicyModelClient(transport as never);
      const events = await collect(client.stream({ ...active, routingPolicy: 'resilient' }, request));
      expect(attempted).toEqual(['anthropic', 'opencode-go']);
      expect(events.some((event) => event.type === 'delta' && event.text === 'ok')).toBe(true);
      expect(decisions.some((decision) => decision.reason === 'fallback' && decision.attempt === 2)).toBe(true);
    } finally { unsubscribe(); }
  });

  it('never combines providers after any response text has streamed', async () => {
    const attempted: string[] = [];
    const transport = { stream: async function* (config: typeof active) {
      attempted.push(config.providerId);
      yield { type: 'delta', text: 'partial' } as UnifiedEvent;
      throw new ProviderHttpError(503, 'Unavailable', '{"error":{"message":"upstream stopped"}}');
    } };
    const client = new PolicyModelClient(transport as never);
    await expect(collect(client.stream({ ...active, routingPolicy: 'resilient' }, request))).rejects.toMatchObject({ status: 503 });
    expect(attempted).toEqual(['anthropic']);
  });

  it('keeps a user-supplied key on its configured endpoint', async () => {
    const attempted: string[] = [];
    const transport = { stream: async function* (config: typeof active) {
      attempted.push(config.providerId);
      throw new ProviderHttpError(429, 'Too Many Requests', '{"error":{"message":"exact upstream error"}}');
    } };
    const client = new PolicyModelClient(transport as never);
    await expect(collect(client.stream({ ...active, apiKey: 'user-key', credentialMode: 'user', routingPolicy: 'resilient' }, request))).rejects.toMatchObject({ status: 429, message: 'exact upstream error' });
    expect(attempted).toEqual(['anthropic']);
  });
});
