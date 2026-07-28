export type ProviderId = 'openai' | 'anthropic' | 'deepseek' | 'mistral' | 'huggingface' | 'zai' | 'minimax' | 'moonshot' | 'openrouter' | 'xai' | 'groq';
export type Dialect = 'auto' | 'openai' | 'anthropic';
export type ResolvedDialect = Exclude<Dialect, 'auto'>;
export interface ProviderDefinition { id: ProviderId; label: string; baseUrl: string; model: string; dialect: Dialect }
export interface RoutingConfig { providerId: ProviderId; baseUrl: string; model: string; dialect: Dialect }
export interface ConversationMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface ConversationRequest { messages: ConversationMessage[]; maxTokens?: number; temperature?: number }
export type UnifiedEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; usage: Record<string, number> }
  | { type: 'done'; finishReason: string }
  | { type: 'error'; error: unknown };
export interface SSEFrame { event: string; data: string }
export const ANTHROPIC_VERSION: string;
export const PROVIDERS: Readonly<Record<ProviderId, ProviderDefinition>>;
export class RoutingConfigurationError extends Error {}
export function getProvider(providerId: ProviderId): ProviderDefinition;
export function normalizeBaseUrl(value: string): string;
export function detectDialect(config: RoutingConfig): ResolvedDialect;
export function buildUpstreamRequest(config: RoutingConfig, request: ConversationRequest): { dialect: ResolvedDialect; url: string; headers: Record<string, string>; body: Record<string, unknown> };
export class SSEDecoder { push(chunk: Uint8Array | string, final?: boolean): SSEFrame[] }
export function normalizeUsageMetrics(value: unknown): Record<string, number>;
export function normalizeProviderEvent(dialect: ResolvedDialect, frame: SSEFrame): UnifiedEvent[];
export function encodeUnifiedSSE(event: UnifiedEvent): string;
export function parseSuccessfulJson(dialect: ResolvedDialect, payload: unknown): UnifiedEvent[];
