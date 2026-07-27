import { afterEach, describe, expect, it } from 'vitest';
import { InlineCompletionService, extractCompletion } from '../src/editor/InlineCompletionService';
import { setRuntimeModelConfig } from '../src/model-routing/runtimeConfig';
import type { UnifiedEvent } from '../src/model-routing/core.mjs';

afterEach(() => setRuntimeModelConfig({ apiKey: '', credentialMode: 'user', inlineCompletionEnabled: true }));

describe('provider-routed inline completion', () => {
  it('extracts tagged or fenced completion output', () => {
    expect(extractCompletion('<completion>return 42;</completion>')).toBe('return 42;');
    expect(extractCompletion('```ts\nreturn 7;\n```')).toBe('return 7;');
  });

  it('uses the shared memory-only routing configuration and bounded context', async () => {
    setRuntimeModelConfig({ providerId: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'fast', dialect: 'openai', apiKey: 'memory-only', credentialMode: 'user', inlineCompletionEnabled: true });
    const calls: unknown[] = [];
    const client = { stream: async function* (config: unknown, request: unknown) { calls.push({ config, request }); yield { type: 'delta', text: '<completion>value + 1</completion>' } as UnifiedEvent; yield { type: 'done', finishReason: 'stop' } as UnifiedEvent; } };
    const service = new InlineCompletionService(client as never);
    await expect(service.suggest({ path: '/repo/main.ts', languageId: 'typescript', prefix: 'const next = ', suffix: ';', signal: new AbortController().signal })).resolves.toBe('value + 1');
    expect(JSON.stringify(calls[0])).toContain('memory-only');
    expect(JSON.stringify(calls[0])).toContain('<cursor/>');
  });

  it('does not send when disabled or missing a user key', async () => {
    let called = false;
    const service = new InlineCompletionService({ stream: async function* () { called = true; } } as never);
    setRuntimeModelConfig({ apiKey: '', credentialMode: 'user', inlineCompletionEnabled: true });
    await expect(service.suggest({ path: 'x', languageId: 'typescript', prefix: '', suffix: '', signal: new AbortController().signal })).resolves.toBeNull();
    setRuntimeModelConfig({ inlineCompletionEnabled: false, apiKey: 'key' });
    await expect(service.suggest({ path: 'x', languageId: 'typescript', prefix: '', suffix: '', signal: new AbortController().signal })).resolves.toBeNull();
    expect(called).toBe(false);
  });
});
