'use strict';

(function initAnvilCDP(globalScope) {
  const PROTOCOL_VERSION = '1.3';
  const AUTO_DETACH_MS = 5000;
  const RESTRICTED_URL_PREFIXES = ['chrome://', 'extension://', 'chrome-extension://'];
  const attachedTabs = new Map();
  let detachListenerBound = false;

  function getDebuggerTarget(tabId) {
    return { tabId };
  }

  function fromChromeCallback(invoker) {
    return new Promise((resolve, reject) => {
      invoker((result) => {
        const runtimeError = chrome.runtime?.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || 'Unknown Chrome runtime error'));
          return;
        }
        resolve(result);
      });
    });
  }

  function ensureState(tabId) {
    if (!attachedTabs.has(tabId)) {
      attachedTabs.set(tabId, {
        attached: false,
        detachTimer: null
      });
    }
    return attachedTabs.get(tabId);
  }

  function clearDetachTimer(tabId) {
    const state = attachedTabs.get(tabId);
    if (!state || state.detachTimer == null) return;
    clearTimeout(state.detachTimer);
    state.detachTimer = null;
  }

  function releaseTabState(tabId) {
    clearDetachTimer(tabId);
    attachedTabs.delete(tabId);
  }

  function bindOnDetachListener() {
    if (detachListenerBound || !chrome.debugger?.onDetach?.addListener) return;
    chrome.debugger.onDetach.addListener((source) => {
      if (!source || typeof source.tabId !== 'number') return;
      releaseTabState(source.tabId);
    });
    detachListenerBound = true;
  }

  async function getTabUrl(tabId) {
    const tab = await fromChromeCallback((done) => {
      chrome.tabs.get(tabId, done);
    });
    return tab?.url || '';
  }

  function isRestrictedUrl(url) {
    if (typeof url !== 'string' || url.length === 0) return false;
    const normalized = url.toLowerCase();
    return RESTRICTED_URL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  }

  function scheduleAutoDetach(tabId) {
    const state = ensureState(tabId);
    clearDetachTimer(tabId);
    state.detachTimer = setTimeout(() => {
      detach(tabId).catch(() => {});
    }, AUTO_DETACH_MS);
  }

  async function attach(tabId) {
    if (typeof tabId !== 'number') {
      throw new Error('attach requires a numeric tabId');
    }

    const tabUrl = await getTabUrl(tabId);
    if (isRestrictedUrl(tabUrl)) {
      throw new Error(`Cannot attach debugger to restricted URL: ${tabUrl}`);
    }

    bindOnDetachListener();
    const state = ensureState(tabId);
    if (state.attached) {
      scheduleAutoDetach(tabId);
      return { attached: true, tabId };
    }

    await fromChromeCallback((done) => {
      chrome.debugger.attach(getDebuggerTarget(tabId), PROTOCOL_VERSION, done);
    });

    state.attached = true;
    await send(tabId, 'Network.enable', {});
    await send(tabId, 'Runtime.enable', {});
    await send(tabId, 'DOM.enable', {});
    await send(tabId, 'Page.enable', {});
    scheduleAutoDetach(tabId);

    return { attached: true, tabId };
  }

  async function detach(tabId) {
    if (typeof tabId !== 'number') {
      throw new Error('detach requires a numeric tabId');
    }

    const state = attachedTabs.get(tabId);
    if (!state || !state.attached) {
      releaseTabState(tabId);
      return { detached: true, tabId, alreadyDetached: true };
    }

    clearDetachTimer(tabId);
    await fromChromeCallback((done) => {
      chrome.debugger.detach(getDebuggerTarget(tabId), done);
    });

    releaseTabState(tabId);
    return { detached: true, tabId };
  }

  async function send(tabId, method, params = {}) {
    if (typeof tabId !== 'number') {
      throw new Error('send requires a numeric tabId');
    }
    if (typeof method !== 'string' || !method) {
      throw new Error('send requires a non-empty method');
    }

    const state = attachedTabs.get(tabId);
    if (!state || !state.attached) {
      throw new Error(`Debugger is not attached for tab ${tabId}`);
    }

    const result = await fromChromeCallback((done) => {
      chrome.debugger.sendCommand(getDebuggerTarget(tabId), method, params, done);
    });

    scheduleAutoDetach(tabId);
    return result;
  }

  async function execute(tabId, method, params = {}) {
    await attach(tabId);
    const result = await send(tabId, method, params);
    scheduleAutoDetach(tabId);
    return result;
  }

  globalScope.__anvilCDP = {
    attach,
    detach,
    send,
    execute
  };
})(globalThis);
