import { describe, expect, it, vi } from 'vitest';
import { AgentRunner } from '../src/agent/AgentRunner';
import { MockHostGateway } from '../src/platform/host';
import type { UnifiedEvent } from '../src/model-routing/core.mjs';

function response(text: string): UnifiedEvent[] { return [{ type: 'delta', text }, { type: 'done', finishReason: 'stop' }]; }

describe('foreground Agent tool loop', () => {
  it('executes typed tools, records evidence, and feeds results into the next model turn', async () => {
    const gateway = new MockHostGateway();
    const search = vi.fn(async () => [{ path: 'src/main.ts', score: 10, reasons: ['symbol'], symbols: ['main'], snippet: 'main' }]);
    Object.defineProperty(gateway, 'contextSearch', { value: search });
    gateway.agentAppendEvent = vi.fn(gateway.agentAppendEvent.bind(gateway));
    const requests: unknown[] = [];
    const turns = [
      response('<cursem-tool>{"id":"find-1","name":"search","arguments":{"query":"main"}}</cursem-tool>'),
      response('Found it. <cursem-patch>{"changes":[{"path":"src/main.ts","content":"next"}]}</cursem-patch>'),
    ];
    const client = { stream: async function* (_config: unknown, request: unknown) { requests.push(request); for (const event of turns.shift() || []) yield event; } };
    const runner = new AgentRunner();
    const output: string[] = [];
    const result = await runner.run({
      gateway, client: client as never, runId: 'run-1', workspaceRoot: '/test/workspace',
      routing: { providerId: 'deepseek', baseUrl: 'http://127.0.0.1:13031/p/deepseek', model: 'test', dialect: 'openai' },
      messages: [{ role: 'system', content: 'tools' }, { role: 'user', content: 'find main' }], signal: new AbortController().signal,
      onDelta: (text) => output.push(text),
    });
    expect(result).toMatchObject({ toolCalls: 1, text: expect.stringContaining('<cursem-patch>') });
    expect(search).toHaveBeenCalledWith('main', 20);
    expect(gateway.agentAppendEvent).toHaveBeenCalledWith('run-1', 'tool.completed', expect.objectContaining({ name: 'search' }));
    expect(JSON.stringify(requests[1])).toContain('tool-result');
    expect(output.join('')).toContain('✓ search');
  });

  it('interrupts an active provider stream and resumes with queued steering', async () => {
    const gateway = new MockHostGateway();
    let call = 0;
    const requests: unknown[] = [];
    const client = { stream: async function* (_config: unknown, request: unknown, signal?: AbortSignal) {
      requests.push(request); call += 1;
      if (call === 1) {
        yield { type: 'delta', text: 'partial' } as UnifiedEvent;
        await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
      } else for (const event of response('steered result')) yield event;
    } };
    const runner = new AgentRunner();
    const pending = runner.run({
      gateway, client: client as never, runId: 'run-1', workspaceRoot: '/test/workspace',
      routing: { providerId: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'test', dialect: 'openai' },
      messages: [{ role: 'user', content: 'start' }], signal: new AbortController().signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    runner.steer('focus on tests');
    await expect(pending).resolves.toMatchObject({ text: 'steered result' });
    expect(JSON.stringify(requests[1])).toContain('focus on tests');
  });

  it('recovers from malformed tool syntax and requires a typed edit patch before completing', async () => {
    const gateway = new MockHostGateway();
    const search = vi.fn(async () => [{ path: 'src/main.ts', score: 10, reasons: ['text'], symbols: [], snippet: 'main' }]);
    Object.defineProperty(gateway, 'contextSearch', { value: search });
    const requests: unknown[] = [];
    const turns = [
      response('<function><arguments>{"query":"main"}</arguments></function>'),
      response('<function><arguments>["search",{"query":"main"}]</arguments></function>'),
      response('I found the file but forgot the patch.'),
      response('Ready. <cursem-patch>{"changes":[{"path":"src/main.ts","content":"next"}]}</cursem-patch>'),
    ];
    const client = { stream: async function* (_config: unknown, request: unknown) { requests.push(request); for (const event of turns.shift() || []) yield event; } };
    const runner = new AgentRunner();
    const result = await runner.run({
      gateway, client: client as never, runId: 'run-edit', workspaceRoot: '/test/workspace',
      routing: { providerId: 'deepseek', baseUrl: 'http://127.0.0.1:13031/p/deepseek', model: 'test', dialect: 'openai' },
      messages: [{ role: 'system', content: 'edit with tools' }, { role: 'user', content: 'change main' }],
      signal: new AbortController().signal,
      validateFinal: (text) => text.includes('<cursem-patch>') ? null : 'Return exactly one typed <cursem-patch> proposal.',
    });

    expect(result.text).toContain('<cursem-patch>');
    expect(result.toolCalls).toBe(1);
    expect(search).toHaveBeenCalledWith('main', 20);
    expect(JSON.stringify(requests[1])).toContain('protocol-error');
    expect(JSON.stringify(requests[3])).toContain('Return exactly one typed');
  });

  it('stops after two paid protocol corrections instead of looping until the tool limit', async () => {
    const gateway = new MockHostGateway();
    const client = { stream: async function* () {
      for (const event of response('<function><arguments>{"query":"main"}</arguments></function>')) yield event;
    } };

    await expect(new AgentRunner().run({
      gateway, client: client as never, runId: 'run-bounded', workspaceRoot: '/test/workspace',
      routing: { providerId: 'deepseek', baseUrl: 'http://127.0.0.1:13031/p/deepseek', model: 'test', dialect: 'openai' },
      messages: [{ role: 'system', content: 'tools' }, { role: 'user', content: 'find main' }],
      signal: new AbortController().signal,
    })).rejects.toThrow('after 2 correction attempts');
  });

  it('rejects a provider completion with no visible assistant text', async () => {
    const gateway = new MockHostGateway();
    const client = { stream: async function* () { yield { type: 'done', finishReason: 'stop' } as UnifiedEvent; } };

    await expect(new AgentRunner().run({
      gateway, client: client as never, runId: 'run-empty', workspaceRoot: '/test/workspace',
      routing: { providerId: 'deepseek', baseUrl: 'http://127.0.0.1:13031/p/deepseek', model: 'test', dialect: 'openai' },
      messages: [{ role: 'user', content: 'respond' }], signal: new AbortController().signal,
    })).rejects.toThrow('without returning visible text');
  });
});
