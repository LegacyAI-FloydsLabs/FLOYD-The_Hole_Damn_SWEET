import { PROVIDERS, type ConversationRequest, type ProviderId, type RoutingConfig, type UnifiedEvent } from './core.mjs';
import { ProviderHttpError, UnifiedModelClient } from './UnifiedModelClient';
import type { RoutingPolicy } from './runtimeConfig';

export type PolicyRoutingConfig = RoutingConfig & {
  apiKey: string;
  credentialMode?: 'user' | 'host';
  routingPolicy?: RoutingPolicy;
};

export interface RoutingDecision {
  policy: RoutingPolicy;
  providerId: ProviderId;
  model: string;
  attempt: number;
  reason: 'selected' | 'fallback' | 'completed' | 'failed';
  elapsedMs?: number;
  error?: string;
}

type StreamTransport = Pick<UnifiedModelClient, 'stream'>;
const decisionListeners = new Set<(decision: RoutingDecision) => void>();

/** Observe policy choices without exposing credentials or provider payloads. */
export function subscribeRoutingDecisions(listener: (decision: RoutingDecision) => void): () => void {
  decisionListeners.add(listener);
  return () => decisionListeners.delete(listener);
}

function publish(decision: RoutingDecision): void {
  for (const listener of decisionListeners) listener(decision);
}

/**
 * Policy layer for every interactive AI surface. A fallback is allowed only
 * before the provider emits text, so a partial answer is never silently mixed
 * with a second provider's output. User-key mode intentionally stays on the
 * configured endpoint because CURSEM has no authority to reuse that key at a
 * different vendor. Host-key mode may route among configured host providers.
 */
export class PolicyModelClient {
  private readonly latencyEma = new Map<ProviderId, number>();

  constructor(private readonly transport: StreamTransport = new UnifiedModelClient('/gateway')) {}

  async *stream(config: PolicyRoutingConfig, request: ConversationRequest, signal?: AbortSignal): AsyncGenerator<UnifiedEvent> {
    const policy = config.routingPolicy || 'manual';
    const candidates = this.candidates(config, policy);
    let lastError: unknown;

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const startedAt = performance.now();
      let emittedText = false;
      publish({ policy, providerId: candidate.providerId, model: candidate.model, attempt: index + 1, reason: index === 0 ? 'selected' : 'fallback' });
      try {
        for await (const event of this.transport.stream(candidate, request, signal)) {
          if (event.type === 'delta' && event.text) emittedText = true;
          yield event;
        }
        const elapsedMs = Math.round(performance.now() - startedAt);
        this.recordLatency(candidate.providerId, elapsedMs);
        publish({ policy, providerId: candidate.providerId, model: candidate.model, attempt: index + 1, reason: 'completed', elapsedMs });
        return;
      } catch (error) {
        lastError = error;
        const elapsedMs = Math.round(performance.now() - startedAt);
        publish({ policy, providerId: candidate.providerId, model: candidate.model, attempt: index + 1, reason: 'failed', elapsedMs, error: error instanceof Error ? error.message : String(error) });
        if (signal?.aborted || emittedText || index === candidates.length - 1 || !isRetryable(error, candidate.credentialMode === 'host')) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('No model provider was available.');
  }

  getLatencyMetrics(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.latencyEma);
  }

  private candidates(config: PolicyRoutingConfig, policy: RoutingPolicy): PolicyRoutingConfig[] {
    const active = { ...config, routingPolicy: policy };
    if (policy === 'manual' || config.credentialMode !== 'host') return [active];

    const defaults = (Object.values(PROVIDERS) as Array<(typeof PROVIDERS)[ProviderId]>).map((provider) => ({
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      model: provider.model,
      dialect: provider.dialect,
      apiKey: '',
      credentialMode: 'host' as const,
      routingPolicy: policy,
    }));
    const preferred = policy === 'cost-first'
      ? defaults.sort((left, right) => costRank(left.providerId) - costRank(right.providerId))
      : policy === 'latency-first'
        ? defaults.sort((left, right) => this.latencyRank(left.providerId, active.providerId) - this.latencyRank(right.providerId, active.providerId))
        : [active, ...defaults];
    return deduplicate(policy === 'resilient' ? preferred : [...preferred, active]);
  }

  private latencyRank(providerId: ProviderId, activeProviderId: ProviderId): number {
    const measured = this.latencyEma.get(providerId);
    if (measured !== undefined) return measured;
    return providerId === activeProviderId ? 1_000_000 : 2_000_000 + costRank(providerId);
  }

  private recordLatency(providerId: ProviderId, elapsedMs: number): void {
    const prior = this.latencyEma.get(providerId);
    this.latencyEma.set(providerId, prior === undefined ? elapsedMs : Math.round(prior * 0.7 + elapsedMs * 0.3));
  }
}

function deduplicate(candidates: PolicyRoutingConfig[]): PolicyRoutingConfig[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.providerId}:${candidate.baseUrl}:${candidate.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function costRank(providerId: ProviderId): number {
  return providerId === 'opencode-go' ? 0 : providerId === 'opencode-zen' ? 1 : providerId === 'openai' ? 2 : 3;
}

function isRetryable(error: unknown, hostManaged: boolean): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  if (error instanceof ProviderHttpError) {
    if (hostManaged && (error.status === 401 || error.status === 403)) return true;
    return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError;
}
