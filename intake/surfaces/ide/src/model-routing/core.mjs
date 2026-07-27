/**
 * Shared provider protocol core.
 *
 * This module deliberately uses only web-platform JavaScript so the browser
 * driver and the Node loopback relay execute the exact same routing rules.
 * API keys are never accepted here: credentials remain HTTP headers and are
 * handled only at the browser/relay boundary.
 */

export const ANTHROPIC_VERSION = '2023-06-01';

export const PROVIDERS = Object.freeze({
  'opencode-go': Object.freeze({
    id: 'opencode-go',
    label: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    model: 'deepseek-v4-flash',
    dialect: 'auto',
  }),
  'opencode-zen': Object.freeze({
    id: 'opencode-zen',
    label: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    model: 'deepseek-v4-flash-free',
    dialect: 'auto',
  }),
  openai: Object.freeze({
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    dialect: 'openai',
  }),
  anthropic: Object.freeze({
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-6',
    dialect: 'anthropic',
  }),
});

const ANTHROPIC_MODEL = /(^|[/:._-])(anthropic|claude|minimax-m(?:2(?:\.5|\.7)?|3)|qwen3\.(?:6|7)(?:-max|-plus)?)([/:._-]|$)/i;
const RESPONSES_ONLY_MODEL = /^(gpt-5(?:\.\d+)?(?:-codex)?|gpt-5-pro)$/i;
const KNOWN_SUFFIX = /\/(?:chat\/completions|messages)\/?$/i;

export class RoutingConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RoutingConfigurationError';
  }
}

export function getProvider(providerId) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new RoutingConfigurationError(`Unknown provider: ${String(providerId)}`);
  return provider;
}

export function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RoutingConfigurationError('API base URL is required.');
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new RoutingConfigurationError('API base URL must be an absolute URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new RoutingConfigurationError('API base URL must use http or https.');
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new RoutingConfigurationError('API base URL cannot contain credentials, a query, or a fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(KNOWN_SUFFIX, '');
  return url.toString().replace(/\/$/, '');
}

export function detectDialect({ providerId, baseUrl, model, dialect = 'auto' }) {
  if (dialect === 'openai' || dialect === 'anthropic') return dialect;
  if (dialect !== 'auto') throw new RoutingConfigurationError(`Unsupported dialect: ${String(dialect)}`);
  const rawBase = baseUrl;
  const normalizedBase = normalizeBaseUrl(rawBase);
  if (providerId === 'anthropic' || /api\.anthropic\.com/i.test(normalizedBase) || /\/messages\/?$/i.test(rawBase)) {
    return 'anthropic';
  }
  if (ANTHROPIC_MODEL.test(model || '')) return 'anthropic';
  return 'openai';
}

function coerceMessage(message) {
  if (!message || typeof message !== 'object') throw new RoutingConfigurationError('Every message must be an object.');
  const role = message.role;
  if (role !== 'system' && role !== 'user' && role !== 'assistant') {
    throw new RoutingConfigurationError(`Unsupported message role: ${String(role)}`);
  }
  if (typeof message.content !== 'string') throw new RoutingConfigurationError('Message content must be a string.');
  return { role, content: message.content };
}

/** Build the exact upstream URL, headers, and dialect-specific JSON body. */
export function buildUpstreamRequest(config, request) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const model = String(config.model || '').trim();
  if (!model) throw new RoutingConfigurationError('Model is required.');
  const dialect = detectDialect({ ...config, model });
  if (dialect === 'openai' && RESPONSES_ONLY_MODEL.test(model) && /opencode\.ai/i.test(baseUrl)) {
    throw new RoutingConfigurationError(`${model} uses the Responses API on OpenCode. Choose a Chat Completions model or set a compatible endpoint.`);
  }
  const messages = Array.isArray(request.messages) ? request.messages.map(coerceMessage) : [];
  if (!messages.some((message) => message.role !== 'system')) {
    throw new RoutingConfigurationError('At least one user or assistant message is required.');
  }
  const temperature = Number.isFinite(request.temperature) ? request.temperature : 0.2;
  const maxTokens = Number.isInteger(request.maxTokens) && request.maxTokens > 0 ? request.maxTokens : 4096;

  if (dialect === 'anthropic') {
    const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
    const body = {
      model,
      messages: messages.filter((message) => message.role !== 'system'),
      max_tokens: maxTokens,
      temperature,
      stream: true,
    };
    if (system) body.system = system;
    return {
      dialect,
      url: `${baseUrl}/messages`,
      headers: { accept: 'text/event-stream', 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION },
      body,
    };
  }

  return {
    dialect,
    url: `${baseUrl}/chat/completions`,
    headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
    body: { model, messages, max_tokens: maxTokens, temperature, stream: true },
  };
}

/** Incremental SSE decoder that tolerates fragmented UTF-8 and CRLF frames. */
export class SSEDecoder {
  constructor() {
    this.decoder = new TextDecoder();
    this.buffer = '';
  }

  push(chunk, final = false) {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: !final });
    this.buffer = this.buffer.replace(/\r\n/g, '\n');
    const frames = [];
    let boundary;
    while ((boundary = this.buffer.indexOf('\n\n')) >= 0) {
      const raw = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const parsed = parseSSEFrame(raw);
      if (parsed) frames.push(parsed);
    }
    if (final && this.buffer.trim()) {
      const parsed = parseSSEFrame(this.buffer);
      if (parsed) frames.push(parsed);
      this.buffer = '';
    }
    return frames;
  }
}

function parseSSEFrame(raw) {
  let event = 'message';
  const data = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return null;
  return { event, data: data.join('\n') };
}

export function normalizeUsageMetrics(value, prefix = '', target = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return target;
  for (const [key, entry] of Object.entries(value)) {
    const name = prefix ? `${prefix}_${key}` : key;
    if (typeof entry === 'number' && Number.isFinite(entry)) target[name] = entry;
    else if (entry && typeof entry === 'object' && !Array.isArray(entry)) normalizeUsageMetrics(entry, name, target);
  }
  return target;
}

/** Convert provider events into the single CURSEM event vocabulary. */
export function normalizeProviderEvent(dialect, frame) {
  if (frame.data === '[DONE]') return [{ type: 'done', finishReason: 'stop' }];
  let data;
  try {
    data = JSON.parse(frame.data);
  } catch {
    return [{ type: 'error', error: { message: 'Provider sent malformed SSE JSON.', raw: frame.data } }];
  }
  if (frame.event === 'error' || data.type === 'error' || data.error) {
    return [{ type: 'error', error: data.error || data }];
  }
  if (dialect === 'anthropic') {
    if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta' && typeof data.delta.text === 'string') {
      return [{ type: 'delta', text: data.delta.text }];
    }
    if (data.type === 'message_start' && data.message?.usage) return [{ type: 'usage', usage: normalizeUsageMetrics(data.message.usage) }];
    if (data.type === 'message_delta' && data.usage) return [{ type: 'usage', usage: normalizeUsageMetrics(data.usage) }];
    if (data.type === 'message_stop') return [{ type: 'done', finishReason: 'stop' }];
    return [];
  }
  const choice = data.choices?.[0];
  const events = [];
  if (typeof choice?.delta?.content === 'string' && choice.delta.content) events.push({ type: 'delta', text: choice.delta.content });
  if (data.usage) events.push({ type: 'usage', usage: normalizeUsageMetrics(data.usage) });
  if (choice?.finish_reason) events.push({ type: 'done', finishReason: choice.finish_reason });
  return events;
}

export function encodeUnifiedSSE(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function parseSuccessfulJson(dialect, payload) {
  if (dialect === 'anthropic') {
    const text = Array.isArray(payload?.content)
      ? payload.content.filter((part) => part?.type === 'text').map((part) => part.text).join('')
      : '';
    return [{ type: 'delta', text }, ...(payload?.usage ? [{ type: 'usage', usage: normalizeUsageMetrics(payload.usage) }] : []), { type: 'done', finishReason: payload?.stop_reason || 'stop' }];
  }
  const text = payload?.choices?.[0]?.message?.content;
  return [{ type: 'delta', text: typeof text === 'string' ? text : '' }, ...(payload?.usage ? [{ type: 'usage', usage: normalizeUsageMetrics(payload.usage) }] : []), { type: 'done', finishReason: payload?.choices?.[0]?.finish_reason || 'stop' }];
}
