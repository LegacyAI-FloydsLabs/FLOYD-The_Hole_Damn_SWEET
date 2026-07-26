// checkpoint.js — Session checkpointing for Floyd TTY Bridge
// Save/restore agent session state: URL, scroll position, element refs, tab group.
'use strict';

// INTEGRATION: importScripts('checkpoint.js'); in background.js
// INTEGRATION: Add to background.js handleBrowserApiTool():
//   case 'checkpoint_save': return checkpointSave(args);
//   case 'checkpoint_restore': return checkpointRestore(args);

(function initCheckpoint(globalScope) {
  const CHECKPOINT_PREFIX = 'floydCheckpoint_';
  const HOT_STATE_KEY = 'floydHotState';
  const PAGE_LOAD_TIMEOUT_MS = 5000;

  /**
   * Wrap chrome.tabs.sendMessage in a promise with lastError handling.
   * Returns fallback value if content script is unreachable.
   */
  function sendToContentScript(tabId, message, fallback) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(fallback);
        } else {
          resolve(response || fallback);
        }
      });
    });
  }

  /**
   * Save a checkpoint of the current session state.
   * Captures URL, title, scroll position, element ref map, and tab group ID.
   *
   * @param {object} [args] - Optional arguments (reserved for future use)
   * @returns {Promise<{success: boolean, checkpoint?: object, error?: string}>}
   */
  async function checkpointSave(args = {}) {
    try {
      // 1. Get active tab info
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) {
        return { success: false, error: 'No active tab found' };
      }

      // 2. Get scroll position and element refs from content script
      const defaultState = { scrollX: 0, scrollY: 0, docWidth: 0, docHeight: 0, refMap: {} };
      const contentState = await sendToContentScript(
        tab.id,
        { type: 'checkpoint_get_state' },
        defaultState
      );

      // 3. Get active tab group ID from session storage
      const sessionData = await chrome.storage.session.get('floydActiveGroupId');
      const tabGroupId = sessionData.floydActiveGroupId || null;

      // 4. Build checkpoint object
      const savedAt = new Date().toISOString();
      const key = CHECKPOINT_PREFIX + Date.now();
      const checkpoint = {
        url: tab.url || '',
        title: tab.title || '',
        scrollX: contentState.scrollX || 0,
        scrollY: contentState.scrollY || 0,
        docWidth: contentState.docWidth || 0,
        docHeight: contentState.docHeight || 0,
        refMap: contentState.refMap || {},
        tabGroupId,
        savedAt
      };

      // 5. Persist checkpoint to local storage
      await chrome.storage.local.set({ [key]: checkpoint });

      // 6. Update hot state in session storage for quick retrieval
      await chrome.storage.session.set({
        [HOT_STATE_KEY]: {
          lastCheckpointKey: key,
          activeOperation: null
        }
      });

      return { success: true, checkpoint: { key, url: checkpoint.url, savedAt } };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to save checkpoint' };
    }
  }

  /**
   * Restore a previously saved checkpoint.
   * Navigates to the saved URL and restores scroll position.
   *
   * @param {object} [args]
   * @param {string} [args.key] - Checkpoint key. If omitted, restores the most recent checkpoint.
   * @returns {Promise<{success: boolean, restored?: object, error?: string}>}
   */
  async function checkpointRestore(args = {}) {
    try {
      let key = args.key;

      // 1. If no key provided, resolve from hot state
      if (!key) {
        const hotData = await chrome.storage.session.get(HOT_STATE_KEY);
        key = hotData[HOT_STATE_KEY]?.lastCheckpointKey;
      }

      if (!key) {
        return { success: false, error: 'No checkpoint key provided and no recent checkpoint found' };
      }

      // 2. Read checkpoint from local storage
      const stored = await chrome.storage.local.get(key);
      const checkpoint = stored[key];

      if (!checkpoint) {
        return { success: false, error: `Checkpoint not found: ${key}` };
      }

      // 3. Get active tab for navigation
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) {
        return { success: false, error: 'No active tab found' };
      }

      // 4. Navigate to saved URL
      await chrome.tabs.update(tab.id, { url: checkpoint.url });

      // 5. Wait for page load (webNavigation listener with timeout fallback)
      await new Promise((resolve) => {
        const onCompleted = (details) => {
          if (details.tabId === tab.id && details.frameId === 0) {
            chrome.webNavigation.onCompleted.removeListener(onCompleted);
            resolve();
          }
        };
        chrome.webNavigation.onCompleted.addListener(onCompleted);

        // Fallback: resolve after timeout if onCompleted never fires
        setTimeout(() => {
          chrome.webNavigation.onCompleted.removeListener(onCompleted);
          resolve();
        }, PAGE_LOAD_TIMEOUT_MS);
      });

      // 6. Restore scroll position (best-effort)
      if (checkpoint.scrollX || checkpoint.scrollY) {
        await sendToContentScript(
          tab.id,
          {
            type: 'checkpoint_restore_scroll',
            scrollX: checkpoint.scrollX,
            scrollY: checkpoint.scrollY
          },
          null
        );
      }

      return {
        success: true,
        restored: {
          url: checkpoint.url,
          scrollX: checkpoint.scrollX,
          scrollY: checkpoint.scrollY,
          savedAt: checkpoint.savedAt
        }
      };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to restore checkpoint' };
    }
  }

  // Expose on globalThis for importScripts() in service worker
  globalScope.checkpointSave = checkpointSave;
  globalScope.checkpointRestore = checkpointRestore;
})(globalThis);
