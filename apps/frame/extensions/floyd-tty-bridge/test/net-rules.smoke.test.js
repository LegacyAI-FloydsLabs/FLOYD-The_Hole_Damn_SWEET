import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('net-rules.js smoke test', () => {
  let addNetRule, removeNetRule;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    chrome.declarativeNetRequest.updateDynamicRules.mockResolvedValue(undefined);
    chrome.declarativeNetRequest.getDynamicRules.mockResolvedValue([]);
    await import('../net-rules.js');
    addNetRule = globalThis.addNetRule;
    removeNetRule = globalThis.removeNetRule;
  });

  it('loads without errors and exposes addNetRule/removeNetRule', () => {
    expect(typeof addNetRule).toBe('function');
    expect(typeof removeNetRule).toBe('function');
  });

  it('addNetRule creates a block rule via upsert pattern', async () => {
    const result = await addNetRule({
      id: 1,
      action: 'block',
      condition: { urlFilter: '*://ads.example.com/*', resourceTypes: ['script'] }
    });

    expect(result).toEqual({ success: true, ruleId: 1 });
    expect(chrome.declarativeNetRequest.updateDynamicRules).toHaveBeenCalledWith({
      addRules: [expect.objectContaining({
        id: 1,
        action: { type: 'block' },
        condition: { urlFilter: '*://ads.example.com/*', resourceTypes: ['script'] }
      })],
      removeRuleIds: [1]
    });
  });

  it('addNetRule rejects invalid rule IDs', async () => {
    const zeroId = await addNetRule({ id: 0, action: 'block', condition: { urlFilter: '*' } });
    expect(zeroId).toEqual({ success: false, error: 'Rule ID must be a positive integer' });

    const negId = await addNetRule({ id: -5, action: 'block', condition: { urlFilter: '*' } });
    expect(negId).toEqual({ success: false, error: 'Rule ID must be a positive integer' });

    const floatId = await addNetRule({ id: 1.5, action: 'block', condition: { urlFilter: '*' } });
    expect(floatId).toEqual({ success: false, error: 'Rule ID must be a positive integer' });

    expect(chrome.declarativeNetRequest.updateDynamicRules).not.toHaveBeenCalled();
  });

  it('addNetRule rejects invalid actions', async () => {
    const result = await addNetRule({ id: 1, action: 'allow', condition: { urlFilter: '*' } });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid action');
  });

  it('removeNetRule removes a rule by ID', async () => {
    const result = await removeNetRule({ id: 42 });

    expect(result).toEqual({ success: true, removedId: 42 });
    expect(chrome.declarativeNetRequest.updateDynamicRules).toHaveBeenCalledWith({
      removeRuleIds: [42]
    });
  });
});
