import { PolicyModelClient } from '@/model-routing';
import { getRuntimeModelConfig } from '@/model-routing/runtimeConfig';

export interface InlineCompletionRequest {
  path: string;
  languageId: string;
  prefix: string;
  suffix: string;
  signal: AbortSignal;
}

export interface InlineCompletionMetric {
  path: string;
  providerId: string;
  model: string;
  latencyMs: number;
  chars: number;
  cancelled: boolean;
}

const SYSTEM = `You are CURSEM Tab, a low-latency code completion engine. Predict only the code that belongs exactly at <cursor>. Use the surrounding prefix and suffix. Return only the insertion inside <completion>...</completion>; no explanation or Markdown.`;

export class InlineCompletionService {
  constructor(private readonly client = new PolicyModelClient()) {}

  async suggest(request: InlineCompletionRequest): Promise<string | null> {
    const config = getRuntimeModelConfig();
    if (!config.inlineCompletionEnabled) return null;
    const startedAt = performance.now();
    let text = '';
    try {
      for await (const event of this.client.stream(config, {
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `<file path=${JSON.stringify(request.path)} language=${JSON.stringify(request.languageId)}>\n<prefix>\n${request.prefix.slice(-12_000)}\n</prefix><cursor/><suffix>\n${request.suffix.slice(0, 4_000)}\n</suffix>\n</file>` },
        ],
        maxTokens: 256,
        temperature: 0.1,
      }, request.signal)) {
        if (event.type === 'delta') text += event.text;
        if (event.type === 'error') throw new Error(typeof event.error === 'string' ? event.error : JSON.stringify(event.error));
      }
      const completion = extractCompletion(text);
      emitMetric({ path: request.path, providerId: config.providerId, model: config.model, latencyMs: Math.round(performance.now() - startedAt), chars: completion.length, cancelled: false });
      return completion || null;
    } catch (error) {
      emitMetric({ path: request.path, providerId: config.providerId, model: config.model, latencyMs: Math.round(performance.now() - startedAt), chars: 0, cancelled: request.signal.aborted });
      if (request.signal.aborted) return null;
      throw error;
    }
  }
}

export function extractCompletion(text: string): string {
  const tagged = text.match(/<completion>([\s\S]*?)<\/completion>/i)?.[1];
  const value = tagged ?? text.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
  return value.replace(/^\n/, '').replace(/\n$/, '');
}

function emitMetric(metric: InlineCompletionMetric): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('cursem:inline-completion-metric', { detail: metric }));
}
