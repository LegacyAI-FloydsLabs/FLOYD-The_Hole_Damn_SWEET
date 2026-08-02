import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import {
  SSEDecoder,
  buildUpstreamRequest,
  encodeUnifiedSSE,
  normalizeProviderEvent,
  parseSuccessfulJson,
} from '../src/model-routing/core.mjs';
import { qualifyProxyModel, resolveCredentialProxy as resolveDefaultCredentialProxy } from './credential-proxy.mjs';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
const RESPONSE_HEADERS = ['content-type', 'cache-control', 'retry-after', 'x-request-id', 'request-id'];

/**
 * Production loopback reverse proxy for POST /gateway.
 *
 * The handler accepts Node IncomingMessage/ServerResponse objects so CURSEM's
 * development and production loopback servers can mount the same code. The
 * `requestUpstream` option is injectable strictly for lifecycle tests.
 */
export async function handleGateway(req, res, options = {}) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'Method not allowed.' } }, { allow: 'POST' });

  let parsed;
  try {
    parsed = JSON.parse((await readBoundedBody(req, MAX_BODY_BYTES)).toString('utf8'));
  } catch (error) {
    const status = error?.code === 'BODY_TOO_LARGE' ? 413 : 400;
    return sendJson(res, status, { error: { message: error instanceof Error ? error.message : 'Invalid gateway request.' } });
  }

  let upstreamSpec;
  try {
    validateGatewayPayload(parsed);
    upstreamSpec = buildUpstreamRequest(parsed.provider, parsed.request);
    assertSafeTarget(upstreamSpec.url, options.allowedHosts ?? process.env.CURSEM_GATEWAY_ALLOWED_HOSTS);
  } catch (error) {
    return sendJson(res, 400, { error: { message: error instanceof Error ? error.message : 'Invalid routing configuration.' } });
  }

  let credentialHeaders;
  try {
    const proxy = await (options.resolveCredentialProxy || resolveDefaultCredentialProxy)();
    const proxyPath = upstreamSpec.dialect === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
    upstreamSpec = {
      ...upstreamSpec,
      url: new URL(proxyPath, proxy.url).toString(),
      body: {
        ...upstreamSpec.body,
        model: qualifyProxyModel(parsed.provider.providerId, upstreamSpec.body.model),
      },
    };
    assertSafeTarget(upstreamSpec.url, options.allowedCredentialProxyHosts ?? ['localhost', '127.0.0.1', '::1']);
    credentialHeaders = { authorization: `Bearer ${proxy.token}` };
  } catch (error) {
    return sendJson(res, 503, { error: { message: error instanceof Error ? error.message : 'The local credential proxy is unavailable.' } });
  }

  const headers = { ...upstreamSpec.headers, ...credentialHeaders };
  const body = Buffer.from(JSON.stringify(upstreamSpec.body));
  const requestUpstream = options.requestUpstream ?? createNodeUpstreamRequest;
  let transaction;
  let upstreamResponse;
  let closed = false;

  // Client disconnects must immediately cut provider spend. ServerResponse
  // `close` fires for a broken browser socket; `writableEnded` distinguishes it
  // from an ordinary completed response. IncomingMessage `aborted` catches a
  // request body/socket termination before a response exists.
  const abortUpstream = () => {
    if (closed) return;
    closed = true;
    transaction?.abort(new Error('CURSEM client disconnected.'));
    upstreamResponse?.destroy(new Error('CURSEM client disconnected.'));
  };
  const onRequestAborted = () => abortUpstream();
  const onResponseClose = () => { if (!res.writableEnded) abortUpstream(); };
  req.once('aborted', onRequestAborted);
  res.once('close', onResponseClose);

  try {
    transaction = requestUpstream({ url: upstreamSpec.url, headers, body });
    upstreamResponse = await transaction.response;
    if (closed) return;

    if (upstreamResponse.statusCode < 200 || upstreamResponse.statusCode >= 300) {
      // Do not translate vendor failures. Status, body bytes, and diagnostic
      // headers are passed through verbatim so the pane can report the actual
      // 401/429/etc. rather than a synthetic relay error.
      res.writeHead(upstreamResponse.statusCode, selectResponseHeaders(upstreamResponse.headers));
      await pipeWithBackpressure(upstreamResponse, res);
      if (!res.writableEnded) res.end();
      return;
    }

    const contentType = String(upstreamResponse.headers['content-type'] || '');
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'close',
      'x-accel-buffering': 'no',
    });

    // The Vault marks a GLM-served fallback via response headers. Surface it
    // before any provider bytes so clients can show which provider failed and
    // which model actually answered instead of hiding the failure.
    const fallbackProvider = firstHeaderValue(upstreamResponse.headers['x-floyd-fallback']);
    if (fallbackProvider) {
      await writeSSE(res, { type: 'fallback', requestedProvider: fallbackProvider, model: firstHeaderValue(upstreamResponse.headers['x-floyd-fallback-model']) });
    }

    if (!contentType.includes('text/event-stream')) {
      const raw = await readBoundedStream(upstreamResponse, MAX_JSON_RESPONSE_BYTES);
      const payload = JSON.parse(raw.toString('utf8'));
      for (const event of parseSuccessfulJson(upstreamSpec.dialect, payload)) await writeSSE(res, event);
    } else {
      const decoder = new SSEDecoder();
      let sentDone = false;
      for await (const chunk of upstreamResponse) {
        if (closed) break;
        for (const frame of decoder.push(chunk)) {
          for (const event of normalizeProviderEvent(upstreamSpec.dialect, frame)) {
            if (event.type === 'done' && sentDone) continue;
            if (event.type === 'done') sentDone = true;
            await writeSSE(res, event);
          }
        }
      }
      for (const frame of decoder.push(new Uint8Array(), true)) {
        for (const event of normalizeProviderEvent(upstreamSpec.dialect, frame)) {
          if (event.type === 'done' && sentDone) continue;
          if (event.type === 'done') sentDone = true;
          await writeSSE(res, event);
        }
      }
      // Some compatible gateways close a successful stream without emitting a
      // vendor-specific stop frame. CURSEM still emits exactly one terminal
      // event so every UI consumer can deterministically release its state.
      if (!sentDone && !closed) await writeSSE(res, { type: 'done', finishReason: 'stream-closed' });
    }
    if (!closed && !res.writableEnded) res.end();
  } catch (error) {
    if (!closed && !res.headersSent) sendJson(res, 502, { error: { message: error instanceof Error ? error.message : 'Gateway transport failed.' } });
    else if (!closed && !res.writableEnded) res.destroy(error instanceof Error ? error : undefined);
  } finally {
    req.off('aborted', onRequestAborted);
    res.off('close', onResponseClose);
    // Each request uses agent:false, so destroying both stream and request also
    // closes the underlying socket. This trades connection reuse for a strict
    // no-dangling-socket lifecycle and releases unread backpressure buffers.
    upstreamResponse?.destroy();
    transaction?.abort();
  }
}

export function createNodeUpstreamRequest({ url, headers, body }) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  let request;
  const response = new Promise((resolve, reject) => {
    request = transport.request(target, {
      method: 'POST',
      headers: { ...headers, 'content-length': String(body.byteLength) },
      agent: false,
    }, resolve);
    request.once('error', reject);
    request.end(body);
  });
  return {
    response,
    abort(reason) {
      if (request && !request.destroyed) request.destroy(reason);
    },
  };
}

function validateGatewayPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Gateway body must be a JSON object.');
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'provider' && key !== 'request')) throw new Error('Gateway body contains an unsupported field.');
  if (!value.provider || typeof value.provider !== 'object') throw new Error('Gateway provider configuration is required.');
  if (!value.request || typeof value.request !== 'object') throw new Error('Gateway conversation request is required.');
}

function assertSafeTarget(rawUrl, allowedHosts) {
  const target = new URL(rawUrl);
  if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('Gateway target must use http or https.');
  if (target.protocol === 'http:' && !isLoopbackHost(target.hostname)) throw new Error('Plain HTTP provider endpoints are restricted to loopback hosts.');
  if (target.username || target.password) throw new Error('Gateway target cannot contain credentials.');
  const hosts = typeof allowedHosts === 'string'
    ? allowedHosts.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean)
    : Array.isArray(allowedHosts) ? allowedHosts.map((host) => String(host).toLowerCase()) : [];
  if (hosts.length && !hosts.includes(target.hostname.toLowerCase())) throw new Error(`Gateway target host is not allowed: ${target.hostname}`);
}

function isLoopbackHost(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function selectResponseHeaders(source) {
  const headers = { connection: 'close' };
  for (const name of RESPONSE_HEADERS) {
    const value = source[name];
    if (value !== undefined) headers[name] = value;
  }
  return headers;
}

function firstHeaderValue(value) {
  return Array.isArray(value) ? String(value[0] || '') : typeof value === 'string' ? value : '';
}

async function readBoundedBody(req, limit) {
  return readBoundedStream(req, limit);
}

async function readBoundedStream(stream, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > limit) {
      const error = new Error(`Payload exceeds ${limit} bytes.`);
      error.code = 'BODY_TOO_LARGE';
      stream.destroy(error);
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

async function pipeWithBackpressure(source, destination) {
  for await (const chunk of source) {
    if (!destination.write(chunk)) await once(destination, 'drain');
  }
}

async function writeSSE(res, event) {
  if (res.destroyed || res.writableEnded) return;
  if (!res.write(encodeUnifiedSSE(event))) await once(res, 'drain');
}

function sendJson(res, status, payload, headers = {}) {
  if (res.headersSent || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.byteLength, connection: 'close', ...headers });
  res.end(body);
}
