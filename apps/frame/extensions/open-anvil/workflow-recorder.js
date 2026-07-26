'use strict';

(function initWorkflowRecorder(globalScope) {
  const RECORDER_STATE_KEY = '__anvilWorkflowRecorderState';
  const WORKFLOW_STORAGE_PREFIX = 'anvilWorkflows_';

  let _recordingActions = [];
  let _recordingTabId = null;
  let _isRecording = false;

  async function resolveTabId(args = {}) {
    if (Number.isInteger(args.tabId)) {
      return args.tabId;
    }

    let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) {
      const tabs = await chrome.tabs.query({ active: true });
      tab = tabs[0];
    }

    if (!tab || !Number.isInteger(tab.id)) {
      throw new Error('No active tab found');
    }

    return tab.id;
  }

  function buildReplayPrompt(actions) {
    if (!Array.isArray(actions) || actions.length === 0) {
      return 'No recorded actions available.';
    }

    const steps = actions.map((action, index) => {
      const stepNumber = `${index + 1}.`;
      const escapedValue = typeof action.value === 'string'
        ? action.value.replace(/'/g, "\\'")
        : '';
      const escapedText = typeof action.textContent === 'string'
        ? action.textContent.replace(/'/g, "\\'")
        : '';

      if (action.type === 'navigate') {
        const destination = action.value || action.selector || 'the target page';
        return `${stepNumber} Navigate to ${destination}`;
      }

      if (action.type === 'click') {
        if (escapedText) {
          return `${stepNumber} Click the '${escapedText}' element`;
        }
        return `${stepNumber} Click ${action.selector || 'the target element'}`;
      }

      if (action.type === 'input') {
        return `${stepNumber} Type '${escapedValue}' into ${action.selector || 'the input field'}`;
      }

      if (action.type === 'select') {
        return `${stepNumber} Select '${escapedValue}' in ${action.selector || 'the select field'}`;
      }

      if (action.type === 'scroll') {
        const x = action.coordinates && Number.isFinite(action.coordinates.x) ? action.coordinates.x : 0;
        const y = action.coordinates && Number.isFinite(action.coordinates.y) ? action.coordinates.y : 0;
        return `${stepNumber} Scroll to position (${x}, ${y})`;
      }

      return `${stepNumber} Perform ${action.type} on ${action.selector || 'the page'}`;
    });

    return steps.join('\n');
  }

  async function syncActionsFromTab(tabId) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (recorderStateKey) => {
        const state = window[recorderStateKey];
        if (!state || !Array.isArray(state.actions)) {
          return [];
        }
        return state.actions.slice();
      },
      args: [RECORDER_STATE_KEY]
    });

    _recordingActions = Array.isArray(result && result.result) ? result.result : [];
    return _recordingActions;
  }

  async function recordStart(args = {}) {
    try {
      const tabId = await resolveTabId(args);

      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (recorderStateKey) => {
          const root = window;
          const now = () => new Date().toISOString();
          const trimText = (value) => {
            if (typeof value !== 'string') {
              return '';
            }
            return value.trim().slice(0, 50);
          };

          const getSelector = (element) => {
            if (!element || element.nodeType !== Node.ELEMENT_NODE) {
              return 'unknown';
            }

            if (element.id) {
              return `#${CSS.escape(element.id)}`;
            }

            const dataAttrs = ['data-testid', 'data-test', 'data-qa', 'data-cy'];
            for (const attr of dataAttrs) {
              const attrValue = element.getAttribute(attr);
              if (attrValue) {
                return `[${attr}="${CSS.escape(attrValue)}"]`;
              }
            }

            if (element.classList && element.classList.length > 0) {
              const classSelector = Array.from(element.classList)
                .filter(Boolean)
                .slice(0, 1)
                .map((className) => `.${CSS.escape(className)}`)
                .join('');

              if (classSelector) {
                const tagClass = `${element.tagName.toLowerCase()}${classSelector}`;
                if (document.querySelectorAll(tagClass).length === 1) {
                  return tagClass;
                }
              }
            }

            const path = [];
            let current = element;
            while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
              const tag = current.tagName.toLowerCase();
              const parent = current.parentElement;
              if (!parent) {
                break;
              }

              const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
              const index = siblings.indexOf(current) + 1;
              path.unshift(`${tag}:nth-child(${index})`);
              current = parent;
            }

            return path.join(' > ') || element.tagName.toLowerCase();
          };

          const state = root[recorderStateKey] || { actions: [], listeners: null };
          state.actions = [];

          const pushAction = (action) => {
            state.actions.push(action);
          };

          const onClick = (event) => {
            const target = event.target && event.target.closest ? event.target.closest('*') : event.target;
            if (!target || !target.tagName) {
              return;
            }

            pushAction({
              type: 'click',
              selector: getSelector(target),
              coordinates: { x: event.clientX || 0, y: event.clientY || 0 },
              timestamp: now(),
              textContent: trimText(target.textContent || '')
            });
          };

          const onInput = (event) => {
            const target = event.target;
            if (!target || !target.tagName) {
              return;
            }

            const tagName = target.tagName.toLowerCase();
            if (tagName === 'input' && typeof target.type === 'string' && target.type.toLowerCase() === 'password') {
              return;
            }

            if (tagName !== 'input' && tagName !== 'textarea' && tagName !== 'select') {
              return;
            }

            pushAction({
              type: tagName === 'select' ? 'select' : 'input',
              selector: getSelector(target),
              value: typeof target.value === 'string' ? target.value : '',
              timestamp: now()
            });
          };

          const onScroll = () => {
            pushAction({
              type: 'scroll',
              selector: 'window',
              coordinates: { x: window.scrollX || 0, y: window.scrollY || 0 },
              timestamp: now()
            });
          };

          const onNavigate = () => {
            pushAction({
              type: 'navigate',
              selector: 'window.location',
              value: window.location.href,
              timestamp: now()
            });
          };

          if (state.listeners) {
            document.removeEventListener('click', state.listeners.click, true);
            document.removeEventListener('input', state.listeners.input, true);
            document.removeEventListener('change', state.listeners.change, true);
            window.removeEventListener('scroll', state.listeners.scroll, true);
            window.removeEventListener('popstate', state.listeners.popstate, true);
            window.removeEventListener('hashchange', state.listeners.hashchange, true);
          }

          state.listeners = {
            click: onClick,
            input: onInput,
            change: onInput,
            scroll: onScroll,
            popstate: onNavigate,
            hashchange: onNavigate
          };

          document.addEventListener('click', state.listeners.click, true);
          document.addEventListener('input', state.listeners.input, true);
          document.addEventListener('change', state.listeners.change, true);
          window.addEventListener('scroll', state.listeners.scroll, true);
          window.addEventListener('popstate', state.listeners.popstate, true);
          window.addEventListener('hashchange', state.listeners.hashchange, true);

          root[recorderStateKey] = state;
          return { started: true };
        },
        args: [RECORDER_STATE_KEY]
      });

      _recordingActions = [];
      _recordingTabId = tabId;
      _isRecording = true;

      return { success: true, recording: true };
    } catch (error) {
      return { success: false, error: error.message || 'Failed to start recording' };
    }
  }

  async function recordStop(args = {}) {
    try {
      const tabId = Number.isInteger(args.tabId) ? args.tabId : _recordingTabId;
      if (!Number.isInteger(tabId)) {
        return { success: false, error: 'No recording tab available' };
      }

      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (recorderStateKey) => {
          const state = window[recorderStateKey];
          if (!state || !state.listeners) {
            return { stopped: false };
          }

          document.removeEventListener('click', state.listeners.click, true);
          document.removeEventListener('input', state.listeners.input, true);
          document.removeEventListener('change', state.listeners.change, true);
          window.removeEventListener('scroll', state.listeners.scroll, true);
          window.removeEventListener('popstate', state.listeners.popstate, true);
          window.removeEventListener('hashchange', state.listeners.hashchange, true);
          state.listeners = null;
          window[recorderStateKey] = state;
          return { stopped: true };
        },
        args: [RECORDER_STATE_KEY]
      });

      await syncActionsFromTab(tabId);
      _isRecording = false;
      _recordingTabId = null;

      return { success: true, actionCount: _recordingActions.length, recording: false };
    } catch (error) {
      return { success: false, error: error.message || 'Failed to stop recording' };
    }
  }

  async function recordExport(args = {}) {
    try {
      const format = args.format || 'both';
      if (!['json', 'prompt', 'both'].includes(format)) {
        return { success: false, error: 'Invalid format. Use json, prompt, or both.' };
      }

      let actions = _recordingActions;
      const tabId = Number.isInteger(args.tabId) ? args.tabId : _recordingTabId;
      if (Number.isInteger(tabId)) {
        actions = await syncActionsFromTab(tabId);
      }

      const prompt = buildReplayPrompt(actions);
      const timestamp = new Date().toISOString();
      const storageKey = `${WORKFLOW_STORAGE_PREFIX}${timestamp}`;
      const storedPayload = {
        createdAt: timestamp,
        actionCount: actions.length,
        actions,
        prompt
      };
      await chrome.storage.local.set({ [storageKey]: storedPayload });

      const result = {
        success: true,
        format,
        actionCount: actions.length
      };

      if (format === 'json' || format === 'both') {
        result.json = actions;
      }
      if (format === 'prompt' || format === 'both') {
        result.prompt = prompt;
      }

      return result;
    } catch (error) {
      return { success: false, error: error.message || 'Failed to export recording' };
    }
  }

  globalScope.recordStart = recordStart;
  globalScope.recordStop = recordStop;
  globalScope.recordExport = recordExport;
})(globalThis);

// INTEGRATION: importScripts('workflow-recorder.js'); in background.js
// INTEGRATION: Add to background.js handleBrowserApiTool(): case 'record_start': return recordStart(args); case 'record_stop': return recordStop(args); case 'record_export': return recordExport(args);
