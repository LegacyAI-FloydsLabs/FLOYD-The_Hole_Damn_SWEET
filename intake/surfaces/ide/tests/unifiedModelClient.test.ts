import { describe, expect, it, vi } from 'vitest';
import { UnifiedModelClient, type RoutingConfig } from '@/model-routing';

const config: RoutingConfig & { apiKey: string } = {
  providerId: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4-flash', dialect: 'auto', apiKey: 'secret-go-key',
};

function streamResponse(text: string, status = 200): Response {
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } }), {
    status,
    headers: { 'content-type': status === 200 ? 'text/event-stream' : 'application/json' },
  });
}

describe('UnifiedModelClient', () => {
  it('calls the ambient browser fetch without an illegal receiver', async () => {
    const fetchMock = vi.fn(async () => streamResponse('event: done\ndata: {"type":"done","finishReason":"stop"}\n\n'));
    vi.stubGlobal('fetch', fetchMock);
    const client = new UnifiedModelClient('/gateway');

    for await (const _event of client.stream(config, { messages: [{ role: 'user', content: 'Question' }] })) { /* consume */ }

    expect(fetchMock).toHaveBeenCalledWith('/gateway', expect.objectContaining({ method: 'POST' }));
    vi.unstubAllGlobals();
  });

  it('sends credentials only as headers to the same-origin relay and parses unified SSE', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => streamResponse('event: delta\ndata: {"type":"delta","text":"answer"}\n\nevent: done\ndata: {"type":"done","finishReason":"stop"}\n\n'));
    const client = new UnifiedModelClient('/gateway', fetchMock as typeof fetch);
    const events = [];
    for await (const event of client.stream(config, { messages: [{ role: 'user', content: 'Question' }] })) events.push(event);

    expect(events).toEqual([{ type: 'delta', text: 'answer' }, { type: 'done', finishReason: 'stop' }]);
    expect(fetchMock).toHaveBeenCalledWith('/gateway', expect.objectContaining({ method: 'POST' }));
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ authorization: 'Bearer secret-go-key' });
    expect(String(init.body)).not.toContain('secret-go-key');
  });

  it('normalizes nested gateway usage before exposing unified events to the UI', async () => {
    const usage = 'event: usage\ndata: {"type":"usage","usage":{"prompt_tokens":12,"prompt_tokens_details":{"cached_tokens":7}}}\n\n';
    const client = new UnifiedModelClient('/gateway', (async () => streamResponse(usage)) as typeof fetch);
    const events = [];

    for await (const event of client.stream(config, { messages: [{ role: 'user', content: 'Question' }] })) events.push(event);

    expect(events).toEqual([{
      type: 'usage',
      usage: { prompt_tokens: 12, prompt_tokens_details_cached_tokens: 7 },
    }]);
  });

  it('uses Anthropic key and version headers', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => streamResponse('event: done\ndata: {"type":"done","finishReason":"stop"}\n\n'));
    const client = new UnifiedModelClient('/gateway', fetchMock as typeof fetch);
    const anthropic = { providerId: 'anthropic' as const, baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-6', dialect: 'anthropic' as const, apiKey: 'anthropic-secret' };
    for await (const _event of client.stream(anthropic, { messages: [{ role: 'user', content: 'Question' }] })) { /* consume */ }
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ 'x-api-key': 'anthropic-secret', 'anthropic-version': '2023-06-01' });
  });

  it('preserves upstream status, status text, raw body, and error block', async () => {
    const raw = '{"error":{"type":"rate_limit_error","message":"Quota exhausted upstream"}}';
    const client = new UnifiedModelClient('/gateway', (async () => new Response(raw, { status: 429, statusText: 'Too Many Requests' })) as typeof fetch);
    const consume = async () => { for await (const _event of client.stream(config, { messages: [{ role: 'user', content: 'Question' }] })) { /* consume */ } };
    await expect(consume()).rejects.toMatchObject({ status: 429, statusText: 'Too Many Requests', rawBody: raw, message: 'Quota exhausted upstream' });
  });

  it('forwards the browser abort signal to fetch', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })));
    const controller = new AbortController();
    const client = new UnifiedModelClient('/gateway', fetchMock as typeof fetch);
    const consume = async () => { for await (const _event of client.stream(config, { messages: [{ role: 'user', content: 'Question' }] }, controller.signal)) { /* consume */ } };
    const pending = consume();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it('requests host-managed credentials without transmitting a user key', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => streamResponse('event: done\ndata: {"type":"done","finishReason":"stop"}\n\n'));
    const client = new UnifiedModelClient('/gateway', fetchMock as typeof fetch);
    for await (const _event of client.stream({ ...config, apiKey: '', credentialMode: 'host' }, { messages: [{ role: 'user', content: 'Question' }] })) { /* consume */ }
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).not.toHaveProperty('authorization');
    expect(JSON.parse(String(init.body))).toMatchObject({ credentialMode: 'host' });
  });
});
