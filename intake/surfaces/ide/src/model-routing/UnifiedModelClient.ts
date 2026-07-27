import {
  ANTHROPIC_VERSION,
  SSEDecoder,
  detectDialect,
  normalizeUsageMetrics,
  type ConversationRequest,
  type RoutingConfig,
  type UnifiedEvent,
} from './core.mjs';

type FetchLike = typeof fetch;

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly rawBody: string;
  readonly upstreamError: unknown;

  constructor(status: number, statusText: string, rawBody: string) {
    const parsed = parseErrorBody(rawBody);
    const message = extractErrorMessage(parsed) || rawBody || `${status} ${statusText}`;
    super(message);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.statusText = statusText;
    this.rawBody = rawBody;
    this.upstreamError = parsed;
  }
}

/**
 * Browser-side provider driver. It never contacts a vendor origin directly:
 * every request is sent to the same-origin loopback relay. Credentials stay in
 * component memory and in transit headers; they are not placed in JSON or any
 * browser storage mechanism.
 */
export class UnifiedModelClient {
  constructor(
    private readonly gatewayPath = '/gateway',
    private readonly fetchImpl: FetchLike = (...args) => globalThis.fetch(...args),
  ) {}

  async *stream(
    config: RoutingConfig & { apiKey: string; credentialMode?: 'user' | 'host' },
    request: ConversationRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<UnifiedEvent> {
    const credentialMode = 'credentialMode' in config && config.credentialMode === 'host' ? 'host' : 'user';
    const apiKey = config.apiKey.trim();
    if (credentialMode === 'user' && !apiKey) throw new Error('An API key is required for the selected provider.');
    const dialect = detectDialect(config);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (credentialMode === 'user' && dialect === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = ANTHROPIC_VERSION;
    } else if (credentialMode === 'user') {
      headers.authorization = `Bearer ${apiKey}`;
    }

    const response = await this.fetchImpl(this.gatewayPath, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        credentialMode,
        provider: {
          providerId: config.providerId,
          baseUrl: config.baseUrl,
          model: config.model,
          dialect: config.dialect,
        },
        request,
      }),
    });

    if (!response.ok) {
      throw new ProviderHttpError(response.status, response.statusText, await response.text());
    }
    if (!response.body) throw new Error('The gateway returned no response stream.');

    const reader = response.body.getReader();
    const decoder = new SSEDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        for (const frame of decoder.push(value || new Uint8Array(), done)) {
          let event: UnifiedEvent;
          try {
            const parsed = JSON.parse(frame.data) as UnifiedEvent;
            event = parsed.type === 'usage'
              ? { type: 'usage', usage: normalizeUsageMetrics(parsed.usage) }
              : parsed;
          } catch {
            event = { type: 'error', error: { message: 'Gateway sent malformed unified SSE.', raw: frame.data } };
          }
          yield event;
        }
        if (done) break;
      }
    } finally {
      // Cancelling the reader releases browser-side backpressure buffers. The
      // fetch AbortSignal independently tells the relay to abort its provider
      // socket when the user presses Stop or the pane unmounts.
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

function parseErrorBody(rawBody: string): unknown {
  try { return JSON.parse(rawBody); } catch { return rawBody; }
}

function extractErrorMessage(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  const object = value as Record<string, unknown>;
  if (typeof object.message === 'string') return object.message;
  if (object.error && typeof object.error === 'object' && typeof (object.error as Record<string, unknown>).message === 'string') {
    return (object.error as Record<string, string>).message;
  }
  if (typeof object.error === 'string') return object.error;
  return null;
}
