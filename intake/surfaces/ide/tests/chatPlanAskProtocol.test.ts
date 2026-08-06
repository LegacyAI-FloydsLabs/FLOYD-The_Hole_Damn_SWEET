import { describe, expect, it } from 'vitest';
import { parseAgentAsk, parseAgentPlan } from '../src/agent/protocol';

describe('plan-mode <cursem-plan> protocol', () => {
  it('parses a summary and ordered steps', () => {
    const plan = parseAgentPlan('Here is the plan.\n<cursem-plan>{"summary":"Add caching","steps":["Add layer","Wire invalidation"]}</cursem-plan>');
    expect(plan).toEqual({ summary: 'Add caching', steps: ['Add layer', 'Wire invalidation'] });
  });

  it('returns null when no plan envelope is present', () => {
    expect(parseAgentPlan('just some text')).toBeNull();
  });

  it('rejects malformed plans', () => {
    expect(() => parseAgentPlan('<cursem-plan>{bad}</cursem-plan>')).toThrow('invalid JSON');
    expect(() => parseAgentPlan('<cursem-plan>{"summary":"x"}</cursem-plan>')).toThrow('steps');
    expect(() => parseAgentPlan('<cursem-plan>{"steps":["a"]}</cursem-plan>')).toThrow('summary');
    expect(() => parseAgentPlan('<cursem-plan>{"summary":"x","steps":[""]}</cursem-plan>')).toThrow('non-empty');
  });
});

describe('blocking <cursem-ask> protocol', () => {
  it('parses select, confirm, and input questions', () => {
    expect(parseAgentAsk('<cursem-ask>{"id":"1","method":"select","question":"Pick","options":["a","b"]}</cursem-ask>'))
      .toEqual({ id: '1', method: 'select', question: 'Pick', options: ['a', 'b'] });
    expect(parseAgentAsk('<cursem-ask>{"id":"2","method":"confirm","question":"Proceed?"}</cursem-ask>'))
      .toEqual({ id: '2', method: 'confirm', question: 'Proceed?' });
    expect(parseAgentAsk('<cursem-ask>{"id":"3","method":"input","question":"Name?","detail":"Used for the file"}</cursem-ask>'))
      .toEqual({ id: '3', method: 'input', question: 'Name?', detail: 'Used for the file' });
  });

  it('returns null when no ask envelope is present', () => {
    expect(parseAgentAsk('no question here')).toBeNull();
  });

  it('rejects malformed ask requests', () => {
    expect(() => parseAgentAsk('<cursem-ask>{"method":"select","question":"x","options":["a"]}</cursem-ask>')).toThrow('id');
    expect(() => parseAgentAsk('<cursem-ask>{"id":"1","method":"editor","question":"x"}</cursem-ask>')).toThrow('Unsupported ask method');
    expect(() => parseAgentAsk('<cursem-ask>{"id":"1","method":"select","question":"x"}</cursem-ask>')).toThrow('options');
    expect(() => parseAgentAsk('<cursem-ask>{"id":"1","method":"input"}</cursem-ask>')).toThrow('question');
  });
});
