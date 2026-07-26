import { vi } from 'vitest';

// ─── Global Browser APIs ────────────────────────────────────────────────────

class MockMutationObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn();
}
global.MutationObserver = MockMutationObserver;

class MockIntersectionObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
}
global.IntersectionObserver = MockIntersectionObserver;

class MockResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
}
global.ResizeObserver = MockResizeObserver;

class MockAudioContext {
  createMediaStreamSource = vi.fn();
  createScriptProcessor = vi.fn();
  createGain = vi.fn();
  createAnalyser = vi.fn();
  destination = {};
  state = 'running';
  resume = vi.fn();
  suspend = vi.fn();
  close = vi.fn();
}
global.AudioContext = MockAudioContext;
global.webkitAudioContext = MockAudioContext;

class MockRTCPeerConnection {
  addTrack = vi.fn();
  removeTrack = vi.fn();
  addIceCandidate = vi.fn();
  createOffer = vi.fn();
  createAnswer = vi.fn();
  setLocalDescription = vi.fn();
  setRemoteDescription = vi.fn();
  close = vi.fn();
  onicecandidate = null;
  ontrack = null;
  onconnectionstatechange = null;
}
global.RTCPeerConnection = MockRTCPeerConnection;

global.RTCSessionDescription = vi.fn();
global.RTCIceCandidate = vi.fn();

class MockWebSocket {
  send = vi.fn();
  close = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
}
global.WebSocket = MockWebSocket;

global.window = {
  location: { href: 'about:blank', reload: vi.fn() },
  document: global.document || {},
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
  requestAnimationFrame: vi.fn((cb) => setTimeout(cb, 0)),
  cancelAnimationFrame: vi.fn(),
  fetch: vi.fn(),
  localStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn()
  },
  sessionStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn()
  },
  navigator: {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    mediaDevices: {
      getUserMedia: vi.fn(),
      getDisplayMedia: vi.fn(),
      enumerateDevices: vi.fn()
    }
  },
  AudioContext: MockAudioContext,
  webkitAudioContext: MockAudioContext,
  AudioWorklet: {
    addModule: vi.fn()
  },
  RTCPeerConnection: MockRTCPeerConnection,
  RTCSessionDescription: global.RTCSessionDescription,
  RTCIceCandidate: global.RTCIceCandidate,
  WebSocket: MockWebSocket,
  MediaStream: vi.fn(),
  MediaStreamTrack: vi.fn(),
  CustomEvent: typeof CustomEvent !== 'undefined' ? CustomEvent : vi.fn(),
  Event: typeof Event !== 'undefined' ? Event : vi.fn(),
  MutationObserver: MockMutationObserver,
  IntersectionObserver: MockIntersectionObserver,
  ResizeObserver: MockResizeObserver,
  __TOM_EXTENSION_ID__: 'mock-extension-id'
};

// Mock document object
global.document = {
  getElementById: vi.fn(),
  querySelector: vi.fn(),
  querySelectorAll: vi.fn(),
  createElement: vi.fn(() => ({
    appendChild: vi.fn(),
    removeChild: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setAttribute: vi.fn(),
    getAttribute: vi.fn(),
    style: {},
    classList: {
      add: vi.fn(),
      remove: vi.fn(),
      toggle: vi.fn()
    }
  })),
  body: {
    appendChild: vi.fn(),
    removeChild: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  },
  head: {
    appendChild: vi.fn(),
    removeChild: vi.fn()
  },
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
  readyState: 'complete',
  documentElement: {
    scrollHeight: 1000,
    scrollWidth: 1000
  }
};

// ─── Chrome Extension APIs ──────────────────────────────────────────────────

global.chrome = {
  runtime: {
    id: 'mock-extension-id',
    getURL: vi.fn((path) => `chrome-extension://mock-extension-id/${path}`),
    getManifest: vi.fn(() => ({ version: '5.0.0' })),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
      hasListener: vi.fn()
    },
    onConnect: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
      hasListener: vi.fn()
    },
    onInstalled: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
      hasListener: vi.fn()
    },
    onStartup: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
      hasListener: vi.fn()
    },
    sendMessage: vi.fn(),
    connect: vi.fn(() => ({
      postMessage: vi.fn(),
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      },
      onDisconnect: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      },
      disconnect: vi.fn()
    })),
    connectNative: vi.fn(() => ({
      postMessage: vi.fn(),
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      },
      onDisconnect: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      },
      disconnect: vi.fn()
    })),
    lastError: null
  },

  tabs: {
    query: vi.fn(),
    get: vi.fn(),
    getCurrent: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    duplicate: vi.fn(),
    highlight: vi.fn(),
    move: vi.fn(),
    reload: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    captureVisibleTab: vi.fn(),
    executeScript: vi.fn(),
    insertCSS: vi.fn(),
    removeCSS: vi.fn(),
    sendMessage: vi.fn(),
    connect: vi.fn(),
    group: vi.fn(),
    ungroup: vi.fn(),
    onCreated: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onUpdated: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onRemoved: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onActivated: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onHighlighted: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onMoved: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    }
  },

  storage: {
    local: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
      clear: vi.fn(),
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      }
    },
    sync: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
      clear: vi.fn(),
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      }
    },
    session: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
      clear: vi.fn(),
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      }
    },
    managed: {
      get: vi.fn(),
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      }
    }
  },

  debugger: {
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(),
    getTargets: vi.fn(),
    onEvent: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onDetach: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    }
  },

  scripting: {
    executeScript: vi.fn().mockResolvedValue([]),
    insertCSS: vi.fn(),
    removeCSS: vi.fn(),
    registerContentScripts: vi.fn(),
    unregisterContentScripts: vi.fn(),
    getRegisteredContentScripts: vi.fn(),
    updateContentScripts: vi.fn()
  },

  sidePanel: {
    open: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    toggle: vi.fn(() => Promise.resolve()),
    getOptions: vi.fn(() => Promise.resolve({})),
    setOptions: vi.fn(() => Promise.resolve()),
    setPanelBehavior: vi.fn(() => Promise.resolve()),
    onClosed: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    }
  },

  offscreen: {
    createDocument: vi.fn(),
    closeDocument: vi.fn(),
    hasDocument: vi.fn()
  },

  tabGroups: {
    query: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    move: vi.fn(),
    onCreated: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onUpdated: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onMoved: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onRemoved: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    }
  },

  declarativeNetRequest: {
    updateDynamicRules: vi.fn().mockResolvedValue(undefined),
    getDynamicRules: vi.fn().mockResolvedValue([]),
    updateEnabledRulesets: vi.fn(),
    getDisabledRuleIds: vi.fn(),
    setDisabledRuleIds: vi.fn(),
    getMatchedRules: vi.fn(),
    testMatchOutcome: vi.fn(),
    onRuleMatchedDebug: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    }
  },

  downloads: {
    download: vi.fn(),
    search: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    getFileIcon: vi.fn(),
    open: vi.fn(),
    show: vi.fn(),
    showDefaultFolder: vi.fn(),
    erase: vi.fn(),
    removeFile: vi.fn(),
    acceptDanger: vi.fn(),
    drag: vi.fn(),
    setShelfEnabled: vi.fn(),
    onCreated: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onErased: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onDeterminingFilename: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    }
  },

  permissions: {
    getAll: vi.fn(),
    contains: vi.fn(() => Promise.resolve(true)),
    request: vi.fn(),
    remove: vi.fn(),
    onAdded: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onRemoved: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    }
  },

  webRequest: {
    onBeforeRequest: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onBeforeSendHeaders: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onHeadersReceived: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onCompleted: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    }
  },

  webNavigation: {
    onBeforeNavigate: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onCommitted: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onDOMContentLoaded: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onCompleted: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onErrorOccurred: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    }
  },

  alarms: {
    create: vi.fn(),
    get: vi.fn(),
    getAll: vi.fn(),
    clear: vi.fn(),
    clearAll: vi.fn(),
    onAlarm: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    }
  },

  commands: {
    getAll: vi.fn(),
    onCommand: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    }
  }
};

// ─── xterm Mock ─────────────────────────────────────────────────────────────

class MockTerminal {
  open = vi.fn();
  write = vi.fn();
  writeln = vi.fn();
  clear = vi.fn();
  reset = vi.fn();
  dispose = vi.fn();
  focus = vi.fn();
  blur = vi.fn();
  resize = vi.fn();
  onData = vi.fn(() => vi.fn());
  onTitleChange = vi.fn(() => vi.fn());
  onBell = vi.fn(() => vi.fn());
  onSelectionChange = vi.fn(() => vi.fn());
  options = {};
  element = null;
}
global.Terminal = MockTerminal;

// ─── Service Worker Globals ──────────────────────────────────────────────────
global.importScripts = vi.fn();

// ─── Utility Globals ────────────────────────────────────────────────────────

global.console = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  assert: vi.fn(),
  clear: vi.fn(),
  count: vi.fn(),
  time: vi.fn(),
  timeEnd: vi.fn(),
  group: vi.fn(),
  groupEnd: vi.fn()
};

global.setTimeout = vi.fn((cb) => cb());
global.setInterval = vi.fn();
global.clearTimeout = vi.fn();
global.clearInterval = vi.fn();
global.requestAnimationFrame = vi.fn((cb) => setTimeout(cb, 0));
global.cancelAnimationFrame = vi.fn();

global.Promise = Promise;
global.fetch = vi.fn();
global.URL = URL;
global.URLSearchParams = URLSearchParams;
global.FormData = FormData;
global.Blob = Blob;
global.File = File;
global.FileReader = vi.fn(() => ({
  readAsArrayBuffer: vi.fn(),
  readAsText: vi.fn(),
  readAsDataURL: vi.fn(),
  abort: vi.fn(),
  onload: null,
  onerror: null,
  onprogress: null,
  result: null
}));
global.ArrayBuffer = ArrayBuffer;
global.Uint8Array = Uint8Array;
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;
global.JSON = JSON;
global.Math = Math;
global.Date = Date;
global.RegExp = RegExp;
global.Error = Error;
global.TypeError = TypeError;
global.RangeError = RangeError;
global.SyntaxError = SyntaxError;
