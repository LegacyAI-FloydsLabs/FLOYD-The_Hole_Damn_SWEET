// @vitest-environment node
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleGateway } from '../server/gateway-relay.mjs';

const servers = [];
const TOKEN = 'fv_cursem_0123456789abcdef0123456789abcdef0123456789abcdef';

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

async function relayUrl(resolveCredentialProxy) {
  return listen((req, res) => { void handleGateway(req, res, { resolveCredentialProxy }); });
}

function gatewayBody(provider = {}) {
  return JSON.stringify({
    provider: {
      providerId: 'deepseek',
      baseUrl: 'http://127.0.0.1:13031/v1',
      model: 'deepseek-chat',
      dialect: 'openai',
      ...provider,
    },
    request: {
      messages: [{ role: 'system', content: 'Be exact.' }, { role: 'user', content: 'Hello' }],
      maxTokens: 321,
    },
  });
}

describe('loopback gateway relay', () => {
  it('overwrites browser credentials with the fv capability and routes only to Vault', async () => {
    const observed = {};
    const vault = await listen(async (req, res) => {
      observed.authorization = req.headers.authorization;
      observed.url = req.url;
      observed.body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString('utf8'));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    const relay = await relayUrl(async () => ({ url: new URL(vault), token: TOKEN }));
    const response = await fetch(`${relay}/gateway`, {
      method: 'POST',
      headers: { authorization: 'Bearer browser-key-must-not-win', 'x-api-key': 'also-forbidden', 'content-type': 'application/json' },
      body: gatewayBody(),
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(observed.authorization).toBe(`Bearer ${TOKEN}`);
    expect(observed.url).toBe('/v1/chat/completions');
    expect(observed.body).toMatchObject({ model: 'deepseek/deepseek-chat', max_tokens: 321, stream: true });
    expect(text).toContain('"type":"delta","text":"hello"');
    expect(text.match(/event: done/g)).toHaveLength(1);
  });

  it('surfaces a Vault GLM fallback as the first stream event', async () => {
    const vault = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-floyd-fallback': 'deepseek', 'x-floyd-fallback-model': 'glm-4.8' });
      res.end('data: {"choices":[{"delta":{"content":"served by glm"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    const relay = await relayUrl(async () => ({ url: new URL(vault), token: TOKEN }));
    const response = await fetch(`${relay}/gateway`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: gatewayBody(),
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('event: fallback\ndata: {"type":"fallback","requestedProvider":"deepseek","model":"glm-4.8"}');
    expect(text.indexOf('event: fallback')).toBeLessThan(text.indexOf('"type":"delta"'));
    expect(text).toContain('"type":"delta","text":"served by glm"');
  });

  it('uses the Vault Anthropic route while preserving protocol translation', async () => {
    const observed = {};
    const vault = await listen(async (req, res) => {
      observed.headers = req.headers;
      observed.url = req.url;
      observed.body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString('utf8'));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"anthropic"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
    const relay = await relayUrl(async () => ({ url: new URL(vault), token: TOKEN }));
    const response = await fetch(`${relay}/gateway`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: gatewayBody({
        providerId: 'anthropic',
        baseUrl: 'http://127.0.0.1:13031/p/anthropic/v1',
        model: 'claude-sonnet-4-6',
        dialect: 'anthropic',
      }),
    });
    expect(await response.text()).toContain('"text":"anthropic"');
    expect(observed.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(observed.headers['anthropic-version']).toBe('2023-06-01');
    expect(observed.url).toBe('/v1/messages');
    expect(observed.body.system).toBe('Be exact.');
    expect(observed.body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('preserves Vault upstream status, bytes, and diagnostic headers', async () => {
    const raw = '{"error":{"type":"rate_limit_error","message":"vendor exact message"}}';
    const vault = await listen((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '17', 'x-request-id': 'vendor-request-1' });
      res.end(raw);
    });
    const relay = await relayUrl(async () => ({ url: new URL(vault), token: TOKEN }));
    const response = await fetch(`${relay}/gateway`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: gatewayBody(),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('17');
    expect(response.headers.get('x-request-id')).toBe('vendor-request-1');
    expect(await response.text()).toBe(raw);
  });

  it('rejects a browser-supplied vendor address before opening a socket', async () => {
    const resolver = vi.fn(async () => ({ url: new URL('http://127.0.0.1:9'), token: TOKEN }));
    const relay = await relayUrl(resolver);
    const response = await fetch(`${relay}/gateway`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: gatewayBody({ baseUrl: 'https://api.deepseek.com/v1' }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('local Vault listener');
    expect(resolver).not.toHaveBeenCalled();
  });

  it('aborts the Vault socket when the browser closes its stream', async () => {
    let resolveClosed;
    const vaultClosed = new Promise((resolve) => { resolveClosed = resolve; });
    const vault = await listen((req, res) => {
      req.once('close', () => resolveClosed(true));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"first"},"finish_reason":null}]}\n\n');
    });
    const relay = await relayUrl(async () => ({ url: new URL(vault), token: TOKEN }));
    const controller = new AbortController();
    const response = await fetch(`${relay}/gateway`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: gatewayBody(),
    });
    await response.body.getReader().read();
    controller.abort();
    await expect(Promise.race([
      vaultClosed,
      new Promise((resolve) => setTimeout(() => resolve(false), 1500)),
    ])).resolves.toBe(true);
  });

  it('re-resolves the Vault capability on every request so rotation is immediate', async () => {
    const observed = [];
    const vault = await listen((req, res) => {
      observed.push(req.headers.authorization);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}');
    });
    let capability = null;
    const resolveCredentialProxy = vi.fn(async () => {
      if (!capability) throw new Error('Vault capability unavailable');
      return { url: new URL(vault), token: capability };
    });
    const relay = await relayUrl(resolveCredentialProxy);

    const missing = await fetch(`${relay}/gateway`, {
      method: 'POST',
      headers: { authorization: 'Bearer browser-must-not-win', 'content-type': 'application/json' },
      body: gatewayBody(),
    });
    expect(missing.status).toBe(503);
    expect(observed).toEqual([]);

    capability = TOKEN;
    const loaded = await fetch(`${relay}/gateway`, {
      method: 'POST',
      headers: { authorization: 'Bearer browser-must-not-win', 'content-type': 'application/json' },
      body: gatewayBody(),
    });
    expect(loaded.status).toBe(200);
    expect(observed).toEqual([`Bearer ${TOKEN}`]);
    expect(resolveCredentialProxy).toHaveBeenCalledTimes(2);
  });
});
