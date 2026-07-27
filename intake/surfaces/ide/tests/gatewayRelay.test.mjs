// @vitest-environment node
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleGateway } from '../server/gateway-relay.mjs';

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  })));
});

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

async function relayUrl() {
  return listen((req, res) => { void handleGateway(req, res); });
}

function gatewayBody(baseUrl, provider = {}) {
  return JSON.stringify({
    credentialMode: 'user',
    provider: { providerId: 'opencode-go', baseUrl, model: 'deepseek-v4-flash', dialect: 'openai', ...provider },
    request: { messages: [{ role: 'system', content: 'Be exact.' }, { role: 'user', content: 'Hello' }], maxTokens: 321 },
  });
}

describe('loopback gateway relay', () => {
  it('forwards bearer credentials, translates the request, and normalizes OpenAI SSE', async () => {
    const observed = {};
    const upstream = await listen(async (req, res) => {
      observed.authorization = req.headers.authorization;
      observed.body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString('utf8'));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    const relay = await relayUrl();
    const response = await fetch(`${relay}/gateway`, { method: 'POST', headers: { authorization: 'Bearer exact-key', 'content-type': 'application/json' }, body: gatewayBody(`${upstream}/v1`) });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(observed.authorization).toBe('Bearer exact-key');
    expect(observed.body).toMatchObject({ model: 'deepseek-v4-flash', max_tokens: 321, stream: true });
    expect(text).toContain('"type":"delta","text":"hello"');
    expect(text.match(/event: done/g)).toHaveLength(1);
  });

  it('forwards Anthropic headers and extracts system messages', async () => {
    const observed = {};
    const upstream = await listen(async (req, res) => {
      observed.headers = req.headers;
      observed.body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString('utf8'));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"anthropic"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
    const relay = await relayUrl();
    const response = await fetch(`${relay}/gateway`, {
      method: 'POST',
      headers: { 'x-api-key': 'exact-anthropic-key', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: gatewayBody(`${upstream}/v1/messages`, { providerId: 'anthropic', model: 'claude-sonnet-4-6', dialect: 'anthropic' }),
    });
    expect(await response.text()).toContain('"text":"anthropic"');
    expect(observed.headers['x-api-key']).toBe('exact-anthropic-key');
    expect(observed.headers['anthropic-version']).toBe('2023-06-01');
    expect(observed.body.system).toBe('Be exact.');
    expect(observed.body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('emits one deterministic done event when a compatible stream closes without a vendor stop frame', async () => {
    const upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
    });
    const relay = await relayUrl();
    const response = await fetch(`${relay}/gateway`, { method: 'POST', headers: { authorization: 'Bearer exact-key', 'content-type': 'application/json' }, body: gatewayBody(`${upstream}/v1`) });
    const text = await response.text();
    expect(text).toContain('"finishReason":"stream-closed"');
    expect(text.match(/event: done/g)).toHaveLength(1);
  });

  it('echoes upstream error status, bytes, and diagnostic headers without a synthetic 500', async () => {
    const raw = '{"error":{"type":"rate_limit_error","message":"vendor exact message"}}';
    const upstream = await listen((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '17', 'x-request-id': 'vendor-request-1' });
      res.end(raw);
    });
    const relay = await relayUrl();
    const response = await fetch(`${relay}/gateway`, { method: 'POST', headers: { authorization: 'Bearer exact-key', 'content-type': 'application/json' }, body: gatewayBody(`${upstream}/v1`) });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('17');
    expect(response.headers.get('x-request-id')).toBe('vendor-request-1');
    expect(await response.text()).toBe(raw);
  });

  it('aborts the provider socket when the browser closes its stream', async () => {
    let resolveClosed;
    const providerClosed = new Promise((resolve) => { resolveClosed = resolve; });
    const upstream = await listen((req, res) => {
      req.once('close', () => resolveClosed(true));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"first"},"finish_reason":null}]}\n\n');
    });
    const relay = await relayUrl();
    const controller = new AbortController();
    const response = await fetch(`${relay}/gateway`, { method: 'POST', signal: controller.signal, headers: { authorization: 'Bearer exact-key', 'content-type': 'application/json' }, body: gatewayBody(`${upstream}/v1`) });
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    await expect(Promise.race([providerClosed, new Promise((resolve) => setTimeout(() => resolve(false), 1500))])).resolves.toBe(true);
  });

  it('rejects non-loopback plain HTTP targets before opening a socket', async () => {
    const relay = await relayUrl();
    const response = await fetch(`${relay}/gateway`, { method: 'POST', headers: { authorization: 'Bearer key', 'content-type': 'application/json' }, body: gatewayBody('http://example.com/v1') });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('restricted to loopback');
  });

  it('routes host mode through the credential proxy without putting a provider key in the browser request', async () => {
    const observed = {};
    const proxy = await listen(async (req, res) => {
      observed.authorization = req.headers.authorization;
      observed.body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString('utf8'));
      observed.url = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}');
    });
    const relay = await listen((req, res) => {
      void handleGateway(req, res, { resolveCredentialProxy: async () => ({ url: new URL(proxy), token: 'app-capability' }) });
    });
    const body = JSON.parse(gatewayBody('https://opencode.ai/zen/go/v1'));
    body.credentialMode = 'host';
    const response = await fetch(`${relay}/gateway`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    expect(observed.authorization).toBe('Bearer app-capability');
    expect(observed.url).toBe('/v1/chat/completions');
    expect(observed.body.model).toBe('opencode-go/deepseek-v4-flash');
  });

  it('re-resolves the proxy capability for each request and ignores browser credential headers in host mode', async () => {
    const observed = [];
    const proxy = await listen((req, res) => {
      observed.push(req.headers.authorization);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}');
    });
    let capability = null;
    const resolveCredentialProxy = vi.fn(async () => {
      if (!capability) throw new Error('proxy capability unavailable');
      return { url: new URL(proxy), token: capability };
    });
    const relay = await listen((req, res) => { void handleGateway(req, res, { resolveCredentialProxy }); });
    const body = JSON.parse(gatewayBody('https://opencode.ai/zen/go/v1'));
    body.credentialMode = 'host';

    const missing = await fetch(`${relay}/gateway`, {
      method: 'POST',
      headers: { authorization: 'Bearer browser-must-not-win', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(missing.status).toBe(503);
    expect(observed).toEqual([]);

    capability = 'rotated-app-capability';
    const loaded = await fetch(`${relay}/gateway`, {
      method: 'POST',
      headers: { authorization: 'Bearer browser-must-not-win', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(loaded.status).toBe(200);
    expect(observed).toEqual(['Bearer rotated-app-capability']);
    expect(resolveCredentialProxy).toHaveBeenCalledTimes(2);
  });
});
