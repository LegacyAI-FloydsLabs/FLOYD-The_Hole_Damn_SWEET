// background.js — Floyd's Labs TTY Bridge v5.1.0 Service Worker (Multi-Session)
'use strict';
importScripts('cdp.js');
importScripts('net-rules.js');
importScripts('network-monitor.js');
importScripts('checkpoint.js');
importScripts('workflow-recorder.js');

// ─── State ───────────────────────────────────────────────────────────────────
// Two native host sessions: session 1 (primary/LLM) and session 2 (secondary/vision)
const nativePorts = { 1: null, 2: null };
const reconnectAttempts = { 1: 0, 2: 0 };
let panelPort = null;
let offscreenReady = false;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 1000;

// ─── Startup Logic ──────────────────────────────────────────────────────────
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.runtime.onInstalled.addListener((details) => {
});

// ─── Native Messaging Connection (per session) ─────────────────────────────
async function connectNative(session = 1) {
  if (nativePorts[session]) return; // Already connected

  const hasPermission = await chrome.permissions.contains({ permissions: ['nativeMessaging'] });
  if (!hasPermission) {
    console.error('[Floyd] nativeMessaging permission not granted');
    if (panelPort) {
      panelPort.postMessage({
        type: 'system_event',
        event: 'native_error',
        session,
        error: 'nativeMessaging permission not granted'
      });
    }
    return;
  }

  try {
    const port = chrome.runtime.connectNative('com.floyd.tty');
    nativePorts[session] = port;

    port.onMessage.addListener((msg) => handleNativeMessage(session, msg));

    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      console.error(`[Floyd] NATIVE ${session} DISCONNECT:`, error?.message || 'unknown');
      nativePorts[session] = null;

      // Stop keep-alive if no native hosts connected
      if (!nativePorts[1] && !nativePorts[2]) {
        chrome.alarms.clear('floyd-keep-alive');
      }

      if (panelPort) {
        panelPort.postMessage({
          type: 'system_event',
          event: 'native_disconnected',
          session,
          error: error?.message
        });
      }

      // Auto-reconnect with exponential backoff
      if (reconnectAttempts[session] < MAX_RECONNECT_ATTEMPTS) {
        const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts[session]), 30000);
        reconnectAttempts[session]++;
        console.log(`[Floyd] Retrying native ${session} in ${delay}ms...`);
        setTimeout(() => connectNative(session), delay);
      } else {
        notifyUser('Floyd TTY Bridge', `Session ${session} native host failed permanently.`);
      }
    });

    // Start keep-alive alarm
    chrome.alarms.create('floyd-keep-alive', { periodInMinutes: 0.4 });

    if (panelPort) {
      panelPort.postMessage({ type: 'system_event', event: 'native_connected', session });
    }
  } catch (e) {
    console.error(`[Floyd] Failed to connect native host ${session}:`, e);
  }
}

// ─── Keep-Alive Alarm ────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'floyd-keep-alive') {
    // Ping all connected native hosts
    for (const s of [1, 2]) {
      if (nativePorts[s]) {
        nativePorts[s].postMessage({ type: 'ping' });
      }
    }
    if (!nativePorts[1] && !nativePorts[2]) {
      chrome.alarms.clear('floyd-keep-alive');
    }
  }
});

// ─── Desktop Notifications ──────────────────────────────────────────────────
function notifyUser(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    priority: 2
  });
}

// ─── Offscreen Document ─────────────────────────────────────────────────────
async function ensureOffscreen() {
  if (offscreenReady) return;
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK', 'WORKERS', 'BLOBS'],
      justification: 'Gemini Live audio output playback, WASM execution, and GIF recording'
    });
  }
  offscreenReady = true;
}

// ─── Handle Native Host Messages ─────────────────────────────────────────────
async function handleNativeMessage(session, msg) {
  if (!msg) return;

  if (msg.type === 'ready') {
    reconnectAttempts[session] = 0;
    return;
  }

  if (msg.type === 'tool_response') {
    if (panelPort) {
      panelPort.postMessage({ ...msg, session });
    }
    return;
  }

  if (msg.type === 'file_changed' || msg.type === 'refresh_tab') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) chrome.tabs.reload(tabs[0].id);
    });
    return;
  }

  if (msg.type === 'pong') return;

  if (msg.type === 'tool_call') {
    const result = await routeToolCall(msg);
    if (nativePorts[session]) {
      nativePorts[session].postMessage({
        type: 'tool_response',
        requestId: msg.requestId,
        ...result
      });
    }
    return;
  }

  if (msg.type === 'ragbot_request') {
    if (panelPort) {
      panelPort.postMessage({
        type: 'ragbot_request',
        requestId: msg.requestId,
        query: msg.query || ''
      });
    } else if (nativePorts[session]) {
      nativePorts[session].postMessage({
        type: 'ragbot_response',
        requestId: msg.requestId,
        success: false,
        error: 'Tom side panel is not connected'
      });
    }
    return;
  }

  if (msg.type === 'pty_output') {
    if (panelPort) {
      panelPort.postMessage({ type: 'pty_output', data: msg.data, session });
    }
    return;
  }
}

// ─── Handle Panel Messages ───────────────────────────────────────────────────
function handlePanelMessage(port, msg) {
  const session = msg.session || 1;

  if (msg.type === 'pty_input') {
    if (nativePorts[session]) {
      nativePorts[session].postMessage({ type: 'pty_input', data: msg.data });
    }
    return;
  }

  if (msg.type === 'pty_resize') {
    if (nativePorts[session]) {
      nativePorts[session].postMessage({ type: 'resize', rows: msg.rows, cols: msg.cols });
    }
    return;
  }

  if (msg.type === 'request_session') {
    // Panel is requesting a second native host session
    const s = msg.session || 2;
    if (!nativePorts[s]) {
      connectNative(s);
    }
    return;
  }

  if (msg.type === 'tool_call') {
    // Shell commands route to native host (session 1 by default)
    if (msg.tool === 'execute_shell') {
      const np = nativePorts[1] || nativePorts[2];
      if (np) {
        np.postMessage(msg);
      } else {
        port.postMessage({ type: 'tool_response', requestId: msg.requestId, success: false, error: 'Native host not connected' });
      }
      return;
    }

    routeToolCall(msg).then(result => {
      port.postMessage({ type: 'tool_response', requestId: msg.requestId, ...result });
    });
    return;
  }

  if (msg.type === 'ragbot_response') {
    // Ragbot responses go to session 1 native host (Tom lives there)
    if (nativePorts[1]) {
      nativePorts[1].postMessage({
        type: 'ragbot_response',
        requestId: msg.requestId,
        success: msg.success,
        result: msg.result,
        error: msg.error
      });
    }
    return;
  }
}

// ─── Route Tool Calls to Content Script ──────────────────────────────────────
async function routeToolCall(msg) {
  try {
    let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) {
      const tabs = await chrome.tabs.query({ active: true });
      if (tabs.length > 0) tab = tabs[0];
    }

    const browserApiResult = await handleBrowserApiTool(msg.tool, msg.args, tab);
    if (browserApiResult !== null) {
      return browserApiResult;
    }

    if (!tab?.id) {
      return { success: false, error: 'No active tab found' };
    }

    chrome.tabs.sendMessage(tab.id, { type: 'AGENT_WORKING' }).catch(() => {});
    return new Promise((resolve) => {
      const done = (result) => {
        chrome.tabs.sendMessage(tab.id, { type: 'AGENT_DONE' }).catch(() => {});
        resolve(result);
      };
      chrome.tabs.sendMessage(tab.id, {
        type: 'tool_call',
        requestId: msg.requestId,
        tool: msg.tool,
        args: msg.args || {}
      }, (response) => {
        if (chrome.runtime.lastError) {
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content-script.js']
          }).then(() => {
            chrome.tabs.sendMessage(tab.id, {
              type: 'tool_call',
              requestId: msg.requestId,
              tool: msg.tool,
              args: msg.args || {}
            }, (retryResponse) => {
              if (chrome.runtime.lastError) {
                done({ success: false, error: 'Content script failed: ' + chrome.runtime.lastError.message });
              } else {
                done(retryResponse || { success: false, error: 'No response from content script' });
              }
            });
          }).catch(err => {
            done({ success: false, error: 'Cannot inject into this page: ' + err.message });
          });
        } else {
          done(response || { success: false, error: 'No response from content script' });
        }
      });
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── Browser API Tools ──────────────────────────────────────────────────────
async function handleBrowserApiTool(tool, args, activeTab) {
  switch (tool) {
    case 'open_tab': {
      const newTab = await chrome.tabs.create({ url: args.url });
      await autoJoinTabGroup(newTab.id);
      return { success: true, result: { tabId: newTab.id, url: args.url } };
    }
    case 'close_tab': {
      await chrome.tabs.remove(args.tab_id);
      return { success: true, result: { closed: args.tab_id } };
    }
    case 'switch_tab': {
      await chrome.tabs.update(args.tab_id, { active: true });
      return { success: true, result: { switched: args.tab_id } };
    }
    case 'list_tabs': {
      const tabs = await chrome.tabs.query({});
      return { success: true, result: tabs.map(t => ({
        tabId: t.id, url: t.url, title: t.title, active: t.active, status: t.status
      }))};
    }
    case 'take_screenshot': {
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
      return { success: true, result: { screenshot: dataUrl, format: 'png' } };
    }
    case 'get_tab_state': {
      const tabId = args.tab_id || activeTab?.id;
      if (!tabId) return { success: false, error: 'No tab ID' };
      const tab = await chrome.tabs.get(tabId);
      return { success: true, result: {
        tabId: tab.id, url: tab.url, title: tab.title,
        status: tab.status, active: tab.active
      }};
    }
    case 'execute_local_shell': {
      const np = nativePorts[1] || nativePorts[2];
      if (!np) return { success: false, error: 'Native host not connected' };
      return new Promise((resolve) => {
        const requestId = 'shell_' + Date.now();
        let settled = false;
        const listener = (msg) => {
          if (msg.type === 'tool_response' && msg.requestId === requestId) {
            settled = true;
            np.onMessage.removeListener(listener);
            clearTimeout(timer);
            resolve(msg);
          }
        };
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            try { np.onMessage.removeListener(listener); } catch (_) {}
            resolve({ success: false, error: 'Shell command timed out (30s)' });
          }
        }, 30000);
        np.onMessage.addListener(listener);
        np.postMessage({ type: 'execute_shell', requestId, command: args.command });
      });
    }
    case 'reload_extension': {
      setTimeout(() => chrome.runtime.reload(), 200);
      return { success: true, result: { reloading: true } };
    }
    case 'download': {
      const opts = { url: args.url };
      if (args.filename) opts.filename = args.filename;
      if (args.saveAs) opts.saveAs = true;
      const downloadId = await chrome.downloads.download(opts);
      return { success: true, result: { downloadId } };
    }
    case 'download_status': {
      const items = await chrome.downloads.search({ id: args.downloadId });
      if (!items || items.length === 0) return { success: false, error: 'Download not found' };
      const d = items[0];
      return { success: true, result: {
        id: d.id, state: d.state, filename: d.filename,
        bytesReceived: d.bytesReceived, totalBytes: d.totalBytes, error: d.error
      }};
    }
    case 'create_tab_group': {
      const groupId = await chrome.tabs.group({ tabIds: args.tabIds });
      const updateOpts = {};
      if (args.title) updateOpts.title = args.title;
      if (args.color) updateOpts.color = args.color;
      if (args.collapsed !== undefined) updateOpts.collapsed = args.collapsed;
      if (Object.keys(updateOpts).length > 0) {
        await chrome.tabGroups.update(groupId, updateOpts);
      }
      await chrome.storage.session.set({ floydActiveGroupId: groupId });
      return { success: true, result: { groupId } };
    }
    case 'manage_tab_group': {
      const gid = args.groupId;
      if (!gid) return { success: false, error: 'groupId required' };
      if (args.action === 'collapse') {
        await chrome.tabGroups.update(gid, { collapsed: true });
      } else if (args.action === 'expand') {
        await chrome.tabGroups.update(gid, { collapsed: false });
      } else if (args.action === 'ungroup') {
        const tabs = await chrome.tabs.query({ groupId: gid });
        if (tabs.length > 0) {
          await chrome.tabs.ungroup(tabs.map(t => t.id));
        }
      } else if (args.title || args.color) {
        const updateOpts = {};
        if (args.title) updateOpts.title = args.title;
        if (args.color) updateOpts.color = args.color;
        await chrome.tabGroups.update(gid, updateOpts);
      }
      return { success: true, result: { groupId: gid, action: args.action || 'update' } };
    }
    case 'add_net_rule':
      return addNetRule(args);
    case 'remove_net_rule':
      return removeNetRule(args);
    case 'read_network':
      return readNetwork(args);
    case 'start_network_monitor':
      return startNetworkMonitor(activeTab?.id);
    case 'stop_network_monitor':
      return stopNetworkMonitor();
    case 'checkpoint_save':
      return checkpointSave(args);
    case 'checkpoint_restore':
      return checkpointRestore(args);
    case 'record_start':
      return recordStart({ ...args, tabId: activeTab?.id });
    case 'record_stop':
      return recordStop(args);
    case 'record_export':
      return recordExport(args);
    case 'gif_start':
    case 'gif_add_frame':
    case 'gif_stop': {
      const resp = await chrome.runtime.sendMessage({ type: 'GENERATE_GIF', command: tool, data: args });
      return resp || { success: false, error: 'No response from offscreen' };
    }
    default:
      return null;
  }
}

// ─── Auto-join new tabs to active group ──────────────────────────────────────
async function autoJoinTabGroup(tabId) {
  try {
    const data = await chrome.storage.session.get('floydActiveGroupId');
    if (data.floydActiveGroupId) {
      await chrome.tabs.group({ tabIds: [tabId], groupId: data.floydActiveGroupId });
    }
  } catch (_) {}
}

// ─── Side Panel Connection ───────────────────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'floyd-tty-panel') {
    panelPort = port;

    // Connect session 1 native host when panel opens
    if (!nativePorts[1]) connectNative(1);

    port.onMessage.addListener((msg) => {
      handlePanelMessage(port, msg);
    });

    port.onDisconnect.addListener(() => {
      panelPort = null;
    });

    port.postMessage({
      type: 'system_event',
      event: 'panel_ready',
      nativeConnected: !!nativePorts[1]
    });
  }
});

if (globalThis.__FLOYD_TEST__) {
  globalThis.__floydBackgroundTest = {
    // Wrapped for backward compat: old tests call handleNativeMessage(msg) without session
    handleNativeMessage(sessionOrMsg, msg) {
      if (msg === undefined) return handleNativeMessage(1, sessionOrMsg);
      return handleNativeMessage(sessionOrMsg, msg);
    },
    handlePanelMessage,
    setPanelPort(port) { panelPort = port; },
    // Backward compat: old tests call setNativePort(port), new call setNativePort(session, port)
    setNativePort(sessionOrPort, port) {
      if (port === undefined) { nativePorts[1] = sessionOrPort; }
      else { nativePorts[sessionOrPort] = port; }
    },
    get nativePort() { return nativePorts[1]; },
    set nativePort(p) { nativePorts[1] = p; }
  };
}

// ─── Messages from Content Script ───────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  const sanitize = (s) => {
    if (typeof s !== 'string') return '';
    let out = '';
    for (let i = 0; i < s.length && out.length < 500; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0x20 || c === 0x09) out += s[i];
    }
    return out;
  };

  try {
    if (message.type === 'debug_command') {
      const tabId = message.tabId || sender.tab?.id;
      const method = message.method;
      const params = message.params || {};
      if (!tabId || typeof method !== 'string' || !method) {
        sendResponse({ success: false, error: 'debug_command requires tabId and method' });
        return false;
      }
      globalThis.__floydCDP.execute(tabId, method, params)
        .then(result => sendResponse({ success: true, result }))
        .catch(err => sendResponse({ success: false, error: err.message || 'CDP command failed' }));
      return true;
    }

    if (message.action) {
      handleBrowserApiTool(message.action, message, { id: sender.tab?.id })
        .then(result => {
          sendResponse(result || { success: false, error: 'Unknown action' });
        })
        .catch(err => {
          sendResponse({ success: false, error: err.message || 'Internal error' });
        });
      return true;
    }

    if (message.type === 'interceptor_event') {
      if (message.payload) {
        const { payload } = message;
        const safeEvent = { tool: 'browser_event' };
        if (payload.type === 'console_error') {
          safeEvent.event = 'console_error';
          safeEvent.message = sanitize(payload.message);
        } else if (payload.type === 'network_error') {
          safeEvent.event = 'network_error';
          safeEvent.method = sanitize(payload.method);
          safeEvent.url = sanitize(payload.url);
          safeEvent.status = typeof payload.status === 'number' ? payload.status : 0;
        } else if (payload.type === 'unhandled_exception') {
          safeEvent.event = 'exception';
          safeEvent.message = sanitize(payload.message);
          safeEvent.source = sanitize(payload.filename) + ':' + (payload.lineno || 0);
        } else if (payload.type === 'unhandled_rejection') {
          safeEvent.event = 'promise_rejection';
          safeEvent.reason = sanitize(payload.reason);
        } else {
          return false;
        }

        // Send to session 1 native host (primary)
        if (nativePorts[1]) {
          nativePorts[1].postMessage({
            type: 'tool_call',
            requestId: 'intercept_' + Date.now(),
            tool: 'browser_event',
            args: safeEvent,
          });
        }

        if (panelPort) {
          panelPort.postMessage({ type: 'system_event', event: 'browser_error', details: safeEvent });
        }
      }
      return false;
    }

    if (message.type === 'system_event') {
      const safeMsg = {
        type: 'system_event',
        event: sanitize(message.event || ''),
        tabId: typeof message.tabId === 'number' ? message.tabId : undefined,
        url: typeof message.url === 'string' ? sanitize(message.url) : undefined,
      };
      if (nativePorts[1]) {
        nativePorts[1].postMessage({
          type: 'tool_call',
          requestId: 'sys_' + Date.now(),
          tool: 'system_event',
          args: safeMsg,
        });
      }
      if (panelPort) panelPort.postMessage(safeMsg);
      return false;
    }
  } catch (error) {
    console.error('[Floyd] Error handling message:', error);
  }

  return false;
});

// ─── Keyboard Shortcuts ──────────────────────────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open_side_panel') {
    const win = await chrome.windows.getLastFocused();
    chrome.sidePanel.open({ windowId: win.id });
  }

  if (command === 'capture_context') {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) return;
    const result = await routeToolCall({
      requestId: 'hotkey_' + Date.now(),
      tool: 'analyze_page',
      args: { include_css: true, include_accessibility: true }
    });
    if (nativePorts[1]) {
      nativePorts[1].postMessage({ type: 'tool_response', requestId: 'hotkey_capture', ...result });
    }
    if (panelPort) {
      panelPort.postMessage({ type: 'system_event', event: 'context_captured', result });
    }
  }

  if (command === 'toggle_vision') {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { type: 'toggle_vision_overlay' });
  }
});

// ─── Web Navigation Tracking ────────────────────────────────────────────────
chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId === 0 && panelPort) {
    panelPort.postMessage({
      type: 'system_event',
      event: 'tab_navigated',
      url: details.url,
      tabId: details.tabId
    });
  }
});

// ─── Offscreen Audio Routing ────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PLAY_PCM_AUDIO' || message.type === 'PLAY_AUDIO_URL') {
    ensureOffscreen().then(() => {
      chrome.runtime.sendMessage(message, sendResponse);
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
});
