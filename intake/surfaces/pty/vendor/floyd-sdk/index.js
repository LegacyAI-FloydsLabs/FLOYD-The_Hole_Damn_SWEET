'use strict';

const DEFAULT_FLOYD_CORE_URL = 'http://127.0.0.1:41414';
const FLOYD_EXPERIENCE_VERSION = '1.0.0';
const FLOYD_SDK_PROTOCOL_VERSION = '1.0.0';

class FloydApiError extends Error {
  constructor(method, path, status, payload) {
    const detail = typeof payload === 'string' ? payload : JSON.stringify(payload);
    super(`${method} ${path} -> ${status}: ${detail}`);
    this.name = 'FloydApiError';
    this.method = method;
    this.path = path;
    this.status = status;
    this.payload = payload;
  }
}

/** CommonJS snapshot of the dependency-free @floyd/sdk request boundary. */
class FloydClient {
  constructor({ baseUrl = DEFAULT_FLOYD_CORE_URL, token, fetch: fetchImpl = globalThis.fetch }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.tokenSource = token;
    this.fetchImpl = fetchImpl.bind(globalThis);
  }

  async token() {
    return typeof this.tokenSource === 'function' ? this.tokenSource() : this.tokenSource;
  }

  async request(method, path, body, signal) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.token()}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal
    });
    const text = await response.text();
    let payload = text;
    if (text) {
      try { payload = JSON.parse(text); } catch (_) { /* Preserve exact non-JSON Core body. */ }
    }
    if (!response.ok) throw new FloydApiError(method, path, response.status, payload);
    return payload;
  }

  health(signal) {
    return this.request('GET', '/api/health', undefined, signal);
  }

  state(signal) {
    return this.request('GET', '/api/state', undefined, signal);
  }

  negotiateExperience(input, signal) {
    return this.request('POST', '/api/experience/negotiate', {
      surface_id: input.surface_id,
      sdk_version: input.sdk_version || FLOYD_SDK_PROTOCOL_VERSION,
      supported_envelope_versions: input.supported_envelope_versions || [FLOYD_EXPERIENCE_VERSION],
      capabilities: input.capabilities
    }, signal);
  }

  experience(envelopeId = 'primary', signal) {
    return this.request('GET', `/api/experience/${encodeURIComponent(envelopeId)}`, undefined, signal);
  }

  updateExperience(envelopeId, patch, signal) {
    return this.request('PATCH', `/api/experience/${encodeURIComponent(envelopeId)}`, patch, signal);
  }

  watchExperience(envelopeId = 'primary', { lastEventId, signal } = {}) {
    return this.stream(`/api/experience/${encodeURIComponent(envelopeId)}/stream`, { lastEventId, signal });
  }

  async *stream(path, { lastEventId, signal } = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${await this.token()}`,
        accept: 'text/event-stream',
        ...(lastEventId ? { 'last-event-id': lastEventId } : {})
      },
      signal
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      let payload = text;
      try { payload = JSON.parse(text); } catch (_) { /* Preserve exact non-JSON Core body. */ }
      throw new FloydApiError('GET', path, response.status, payload);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';
        for (const frame of frames) {
          const parsed = parseSseFrame(frame);
          if (parsed) yield parsed;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

function parseSseFrame(frame) {
  let id;
  let type = 'message';
  const dataLines = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('event:')) type = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  let data = raw;
  try { data = JSON.parse(raw); } catch (_) { /* Plain-text SSE is valid. */ }
  return { ...(id ? { id } : {}), type, data };
}

module.exports = {
  DEFAULT_FLOYD_CORE_URL,
  FLOYD_EXPERIENCE_VERSION,
  FLOYD_SDK_PROTOCOL_VERSION,
  FloydApiError,
  FloydClient
};
