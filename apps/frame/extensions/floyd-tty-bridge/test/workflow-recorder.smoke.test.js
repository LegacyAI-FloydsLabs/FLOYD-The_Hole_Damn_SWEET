import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('workflow-recorder.js smoke test', () => {
  let recordStart;
  let recordStop;
  let recordExport;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    chrome.scripting.executeScript.mockResolvedValue([]);
    chrome.storage.local.set.mockResolvedValue(undefined);

    await import('../workflow-recorder.js');
    recordStart = globalThis.recordStart;
    recordStop = globalThis.recordStop;
    recordExport = globalThis.recordExport;
  });

  it('loads and exposes recordStart/recordStop/recordExport', () => {
    expect(typeof recordStart).toBe('function');
    expect(typeof recordStop).toBe('function');
    expect(typeof recordExport).toBe('function');
  });

  it('recordStart injects listeners into MAIN world and enables recording', async () => {
    const result = await recordStart({ tabId: 321 });

    expect(result).toEqual({ success: true, recording: true });
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 321 },
      world: 'MAIN',
      func: expect.any(Function),
      args: expect.any(Array)
    }));
  });

  it('recordStop removes listeners and reports action count', async () => {
    chrome.scripting.executeScript
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ result: [
        { type: 'click', selector: '#submit', timestamp: '2026-01-01T00:00:00.000Z' },
        { type: 'input', selector: '#email', value: 'user@example.com', timestamp: '2026-01-01T00:00:01.000Z' }
      ] }]);

    await recordStart({ tabId: 55 });
    const result = await recordStop({ tabId: 55 });

    expect(result).toEqual({ success: true, actionCount: 2, recording: false });
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(3);
  });

  it('recordExport with both returns json/prompt and persists workflow', async () => {
    const actions = [
      { type: 'navigate', selector: 'window.location', value: 'https://example.com', timestamp: '2026-01-01T00:00:00.000Z' },
      { type: 'click', selector: '#login', textContent: 'Login', timestamp: '2026-01-01T00:00:01.000Z' },
      { type: 'input', selector: '#email', value: 'user@example.com', timestamp: '2026-01-01T00:00:02.000Z' }
    ];

    chrome.scripting.executeScript
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ result: actions }]);

    await recordStart({ tabId: 77 });
    const result = await recordExport({ format: 'both', tabId: 77 });

    expect(result.success).toBe(true);
    expect(result.format).toBe('both');
    expect(result.actionCount).toBe(3);
    expect(result.json).toEqual(actions);
    expect(result.prompt).toContain('1. Navigate to https://example.com');
    expect(result.prompt).toContain("2. Click the 'Login' element");
    expect(result.prompt).toContain("3. Type 'user@example.com' into #email");

    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    const savedPayload = chrome.storage.local.set.mock.calls[0][0];
    const [savedKey] = Object.keys(savedPayload);
    expect(savedKey.startsWith('floydWorkflows_')).toBe(true);
    expect(savedPayload[savedKey].actions).toEqual(actions);
  });

  it('recordExport json format omits prompt output', async () => {
    const actions = [
      { type: 'click', selector: '#submit', textContent: 'Submit', timestamp: '2026-01-01T00:00:00.000Z' }
    ];

    chrome.scripting.executeScript
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ result: actions }]);

    await recordStart({ tabId: 88 });
    const result = await recordExport({ format: 'json', tabId: 88 });

    expect(result).toEqual({
      success: true,
      format: 'json',
      actionCount: 1,
      json: actions
    });
  });
});
