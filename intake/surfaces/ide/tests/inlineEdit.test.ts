import { afterEach, describe, expect, it } from 'vitest';
import { InlineEditService, extractReplacement, replaceInlineSelection } from '../src/editor/InlineEditService';
import { setRuntimeModelConfig } from '../src/model-routing/runtimeConfig';
import type { InlineEditRequestDetail } from '../src/editor/types';
import type { UnifiedEvent } from '../src/model-routing/core.mjs';

const request: InlineEditRequestDetail = {
  path: '/repo/main.ts', languageId: 'typescript', fullContent: 'const one = 1;\nconst two = 2;\n', selectedText: 'const two = 2;',
  startLine: 2, startCol: 1, endLine: 2, endCol: 15,
};

afterEach(() => setRuntimeModelConfig({ apiKey: '', credentialMode: 'user' }));

describe('selection-based Inline Edit', () => {
  it('replaces exactly the selected range in the current buffer', () => {
    expect(replaceInlineSelection(request, 'const two = one + 1;')).toBe('const one = 1;\nconst two = one + 1;\n');
  });

  it('uses the unified provider and extracts a typed replacement', async () => {
    setRuntimeModelConfig({ providerId: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude', dialect: 'anthropic', apiKey: 'key', credentialMode: 'user' });
    const client = { stream: async function* () { yield { type: 'delta', text: '<replacement>const two = one + 1;</replacement>' } as UnifiedEvent; yield { type: 'done', finishReason: 'stop' } as UnifiedEvent; } };
    const service = new InlineEditService(client as never);
    await expect(service.rewrite(request, 'derive two from one', new AbortController().signal)).resolves.toBe('const two = one + 1;');
    expect(extractReplacement('```ts\nnext\n```')).toBe('next');
  });
});
