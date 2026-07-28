import { PROVIDERS, type Dialect, type ProviderId } from './core.mjs';

export interface RuntimeModelConfig {
  providerId: ProviderId;
  baseUrl: string;
  model: string;
  dialect: Dialect;
  inlineCompletionEnabled: boolean;
  routingPolicy: RoutingPolicy;
}

export type RoutingPolicy = 'manual' | 'cost-first' | 'latency-first' | 'resilient';

let runtimeConfig: RuntimeModelConfig = {
  providerId: 'anthropic', baseUrl: PROVIDERS.anthropic.baseUrl,
  model: PROVIDERS.anthropic.model, dialect: PROVIDERS.anthropic.dialect,
  inlineCompletionEnabled: true, routingPolicy: 'manual',
};
const listeners = new Set<(config: RuntimeModelConfig) => void>();

/** Shared model selection. Vault routing is mandatory and not user-configurable. */
export function setRuntimeModelConfig(next: Partial<RuntimeModelConfig>): void {
  runtimeConfig = { ...runtimeConfig, ...next };
  for (const listener of listeners) listener({ ...runtimeConfig });
}
export function getRuntimeModelConfig(): RuntimeModelConfig { return { ...runtimeConfig }; }
export function subscribeRuntimeModelConfig(listener: (config: RuntimeModelConfig) => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
