import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('checkpoint.js smoke test', () => {
  let checkpointSave, checkpointRestore;

  const MOCK_TAB = { id: 1, url: 'https://example.com/page', title: 'Example Page' };
  const MOCK_CONTENT_STATE = {
    scrollX: 120,
    scrollY: 450,
    docWidth: 1920,
    docHeight: 5000,
    refMap: { ref_1: '.hero-section', ref_2: '#main-content' }
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Default mocks for chrome APIs used by checkpoint.js
    chrome.tabs.query.mockResolvedValue([MOCK_TAB]);
    chrome.tabs.update.mockResolvedValue({});
    chrome.tabs.sendMessage.mockImplementation((_tabId, _msg, callback) => {
      if (typeof callback === 'function') callback(MOCK_CONTENT_STATE);
    });
    chrome.storage.local.set.mockResolvedValue(undefined);
    chrome.storage.local.get.mockResolvedValue({});
    chrome.storage.session.get.mockResolvedValue({ floydActiveGroupId: 7 });
    chrome.storage.session.set.mockResolvedValue(undefined);

    await import('../checkpoint.js');
    checkpointSave = globalThis.checkpointSave;
    checkpointRestore = globalThis.checkpointRestore;
  });

  it('loads without errors and exposes checkpointSave/checkpointRestore', () => {
    expect(typeof checkpointSave).toBe('function');
    expect(typeof checkpointRestore).toBe('function');
  });

  it('checkpointSave captures tab state, content state, and stores checkpoint', async () => {
    const result = await checkpointSave();

    expect(result.success).toBe(true);
    expect(result.checkpoint).toBeDefined();
    expect(result.checkpoint.url).toBe('https://example.com/page');
    expect(result.checkpoint.key).toMatch(/^floydCheckpoint_\d+$/);
    expect(result.checkpoint.savedAt).toBeTruthy();

    // Verify chrome.tabs.query was called correctly
    expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });

    // Verify content script was queried for scroll/ref state
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      1,
      { type: 'checkpoint_get_state' },
      expect.any(Function)
    );

    // Verify checkpoint was persisted to local storage
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({
        [result.checkpoint.key]: expect.objectContaining({
          url: 'https://example.com/page',
          title: 'Example Page',
          scrollX: 120,
          scrollY: 450,
          refMap: { ref_1: '.hero-section', ref_2: '#main-content' },
          tabGroupId: 7
        })
      })
    );

    // Verify hot state was written to session storage
    expect(chrome.storage.session.set).toHaveBeenCalledWith({
      floydHotState: {
        lastCheckpointKey: result.checkpoint.key,
        activeOperation: null
      }
    });
  });

  it('checkpointSave returns error when no active tab is found', async () => {
    chrome.tabs.query.mockResolvedValue([]);

    const result = await checkpointSave();

    expect(result).toEqual({ success: false, error: 'No active tab found' });
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('checkpointRestore navigates to saved URL and restores scroll', async () => {
    const checkpointKey = 'floydCheckpoint_1700000000000';
    const savedCheckpoint = {
      url: 'https://example.com/saved',
      title: 'Saved Page',
      scrollX: 0,
      scrollY: 800,
      docWidth: 1920,
      docHeight: 4000,
      refMap: {},
      tabGroupId: 7,
      savedAt: '2025-03-09T12:00:00.000Z'
    };

    chrome.storage.local.get.mockResolvedValue({ [checkpointKey]: savedCheckpoint });

    // Mock sendMessage for scroll restore (checkpoint_restore_scroll)
    chrome.tabs.sendMessage.mockImplementation((_tabId, _msg, callback) => {
      if (typeof callback === 'function') callback(null);
    });

    const result = await checkpointRestore({ key: checkpointKey });

    expect(result.success).toBe(true);
    expect(result.restored).toEqual({
      url: 'https://example.com/saved',
      scrollX: 0,
      scrollY: 800,
      savedAt: '2025-03-09T12:00:00.000Z'
    });

    // Verify navigation
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { url: 'https://example.com/saved' });

    // Verify scroll restore was sent to content script
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      1,
      { type: 'checkpoint_restore_scroll', scrollX: 0, scrollY: 800 },
      expect.any(Function)
    );
  });

  it('checkpointRestore uses most recent checkpoint when no key provided', async () => {
    const lastKey = 'floydCheckpoint_1700000099999';
    const savedCheckpoint = {
      url: 'https://example.com/latest',
      title: 'Latest',
      scrollX: 50,
      scrollY: 200,
      docWidth: 1920,
      docHeight: 3000,
      refMap: {},
      tabGroupId: null,
      savedAt: '2025-03-09T14:00:00.000Z'
    };

    // Hot state points to the most recent checkpoint
    chrome.storage.session.get.mockResolvedValue({
      floydHotState: { lastCheckpointKey: lastKey, activeOperation: null }
    });
    chrome.storage.local.get.mockResolvedValue({ [lastKey]: savedCheckpoint });
    chrome.tabs.sendMessage.mockImplementation((_tabId, _msg, callback) => {
      if (typeof callback === 'function') callback(null);
    });

    const result = await checkpointRestore({});

    expect(result.success).toBe(true);
    expect(result.restored.url).toBe('https://example.com/latest');
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { url: 'https://example.com/latest' });
  });

  it('checkpointRestore returns error for nonexistent checkpoint', async () => {
    chrome.storage.local.get.mockResolvedValue({});

    const result = await checkpointRestore({ key: 'floydCheckpoint_bogus' });

    expect(result).toEqual({
      success: false,
      error: 'Checkpoint not found: floydCheckpoint_bogus'
    });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });
});
