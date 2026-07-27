import { describe, expect, it } from 'vitest';
import { parseAgentPatch, parseAgentToolCall, parseContextSelectors } from '../src/agent/protocol';

describe('typed Agent patch protocol', () => {
  it('parses create, modify, and delete operations across files', () => {
    const result = parseAgentPatch(`Ready.\n<cursem-patch>{"changes":[{"path":"src/a.ts","content":"a"},{"path":"src/b.ts","content":null}]}</cursem-patch>`);
    expect(result).toEqual({ explanation: 'Ready.', changes: [{ path: 'src/a.ts', content: 'a' }, { path: 'src/b.ts', content: null }] });
  });

  it('keeps backward compatibility for an active-file proposal', () => {
    expect(parseAgentPatch('<cursem-file>next</cursem-file>', 'src/main.ts')?.changes).toEqual([{ path: 'src/main.ts', content: 'next' }]);
  });

  it('rejects malformed or duplicate changes', () => {
    expect(() => parseAgentPatch('<cursem-patch>{bad}</cursem-patch>')).toThrow('invalid JSON');
    expect(() => parseAgentPatch('<cursem-patch>{"changes":[{"path":"x","content":"1"},{"path":"x","content":"2"}]}</cursem-patch>')).toThrow('Duplicate');
  });

  it('extracts explicit file, folder, and symbol context selectors', () => {
    expect(parseContextSelectors(`Review @file:"src/main app.ts" with @folder:server and @symbol:buildRouter @symbol:buildRouter`)).toEqual([
      { type: 'file', value: 'src/main app.ts' },
      { type: 'folder', value: 'server' },
      { type: 'symbol', value: 'buildRouter' },
    ]);
  });

  it('validates the typed Agent tool envelope', () => {
    expect(parseAgentToolCall('<cursem-tool>{"id":"1","name":"search","arguments":{"query":"router"}}</cursem-tool>')).toEqual({ id: '1', name: 'search', arguments: { query: 'router' } });
    expect(parseAgentToolCall('<function><arguments>["search",{"query":"router","limit":5}]</arguments></function>')).toEqual({ id: 'legacy-1', name: 'search', arguments: { query: 'router', limit: 5 } });
    expect(parseAgentToolCall('Explain this literal example: <function><arguments>["search",{"query":"router"}]</arguments></function>')).toBeNull();
    expect(() => parseAgentToolCall('<cursem-tool>{"id":"1","name":"shell","arguments":{}}</cursem-tool>')).toThrow('Unsupported Agent tool');
    expect(() => parseAgentToolCall('<function><arguments>{"query":"router"}</arguments></function>')).toThrow('missing a tool name');
  });
});
