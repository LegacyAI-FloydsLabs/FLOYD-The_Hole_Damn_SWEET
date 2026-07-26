// sidepanel.js — Floyd's Labs TTY Bridge v5.1.0 (Dual Terminal Edition)
'use strict';

// Dynamic imports for xterm addons and Gemini Live
let LiveSession = null;
let FitAddon = null;
let WebglAddon = null;
let CanvasAddon = null;
let SearchAddon = null;
let Unicode11Addon = null;

Promise.all([
  import('./node_modules/@xterm/addon-fit/lib/addon-fit.js').then(m => { FitAddon = m.FitAddon; }).catch(e => console.warn('[Floyd] Fit addon unavailable:', e.message)),
  import('./node_modules/@xterm/addon-webgl/lib/addon-webgl.js').then(m => { WebglAddon = m.WebglAddon; }).catch(e => console.warn('[Floyd] WebGL addon unavailable:', e.message)),
  import('./node_modules/@xterm/addon-canvas/lib/addon-canvas.js').then(m => { CanvasAddon = m.CanvasAddon; }).catch(e => console.warn('[Floyd] Canvas addon unavailable:', e.message)),
  import('./node_modules/@xterm/addon-search/lib/addon-search.js').then(m => { SearchAddon = m.SearchAddon; }).catch(e => console.warn('[Floyd] Search addon unavailable:', e.message)),
  import('./node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js').then(m => { Unicode11Addon = m.Unicode11Addon; }).catch(e => console.warn('[Floyd] Unicode11 addon unavailable:', e.message))
]).catch(err => console.warn('[Floyd] Addon loading error:', err.message));

import('./live-service.js')
  .then(mod => { LiveSession = mod.LiveSession; })
  .catch(err => console.warn('[Floyd] Live service unavailable:', err.message));

// ─── Terminal Theme ──────────────────────────────────────────────────────────
const TERM_THEME = {
  background: '#0a0a0a',
  foreground: '#e0e0e0',
  cursor: '#00ff88',
  cursorAccent: '#0a0a0a',
  selectionBackground: '#3388ff44',
  black: '#0a0a0a',
  red: '#ff3388',
  green: '#00ff88',
  yellow: '#ffcc00',
  blue: '#3388ff',
  magenta: '#cc66ff',
  cyan: '#00ccff',
  white: '#e0e0e0',
};

// ─── Terminal Session ────────────────────────────────────────────────────────

class TerminalSession {
  constructor(sessionId, containerId) {
    this.sessionId = sessionId;
    this.containerId = containerId;
    this.term = null;
    this.fitAddon = null;
    this.cols = 0;
    this.rows = 0;
    this._resizing = false;
    this._resizeRAF = null;
    this._observer = null;
    this._init();
  }

  _init() {
    const container = document.getElementById(this.containerId);
    if (!container) {
      console.error(`[Floyd] Fatal: #${this.containerId} not found`);
      return;
    }

    this.term = new (window.Terminal || Terminal)({
      cursorBlink: true,
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      cursorWidth: 2,
      fontFamily: '"SF Mono", "Cascadia Code", "Fira Code", "Courier New", monospace',
      fontWeight: 'bold',
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 10000,
      convertEol: true,
      allowProposedApi: true,
      theme: TERM_THEME,
    });

    this.term.open(container);
    this._loadAddons();
    this.term.write('\x1b[?25h');
  }

  _loadAddons() {
    if (!this.term) return;

    // FitAddon (critical for responsive sizing)
    if (FitAddon) {
      try {
        this.fitAddon = new FitAddon();
        this.term.loadAddon(this.fitAddon);
      } catch (e) {
        console.warn(`[Floyd][T${this.sessionId}] FitAddon failed:`, e.message);
      }
    }

    // Try WebGL, fall back to Canvas
    if (WebglAddon) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          console.warn(`[Floyd][T${this.sessionId}] WebGL context lost, fallback to Canvas`);
          webgl.dispose();
          this._loadCanvas();
        });
        this.term.loadAddon(webgl);
      } catch (e) {
        this._loadCanvas();
      }
    } else {
      this._loadCanvas();
    }

    if (SearchAddon) {
      try { this.term.loadAddon(new SearchAddon()); } catch (_) {}
    }
    if (Unicode11Addon) {
      try {
        const u = new Unicode11Addon();
        this.term.loadAddon(u);
        this.term.unicode.activeVersion = '11';
      } catch (_) {}
    }
  }

  _loadCanvas() {
    if (CanvasAddon) {
      try { this.term.loadAddon(new CanvasAddon()); } catch (_) {}
    }
  }

  fit() {
    if (this._resizing || !this.term) return;
    this._resizing = true;
    try {
      if (this.fitAddon) {
        this.fitAddon.fit();
        const dims = this.fitAddon.proposeDimensions();
        if (dims && (dims.cols !== this.cols || dims.rows !== this.rows)) {
          this.cols = dims.cols;
          this.rows = dims.rows;
          return { cols: dims.cols, rows: dims.rows };
        }
      } else {
        return this._manualFit();
      }
    } catch (e) {
      console.warn(`[Floyd][T${this.sessionId}] Fit error:`, e);
    } finally {
      this._resizing = false;
    }
    return null;
  }

  _manualFit() {
    const container = document.getElementById(this.containerId);
    if (!container || container.clientWidth === 0 || container.clientHeight === 0) return null;

    const span = document.createElement('span');
    const fontFamily = this.term.options?.fontFamily || '"SF Mono", monospace';
    const fontSize = this.term.options?.fontSize || 12;
    span.style.cssText = `position:absolute;top:-9999px;visibility:hidden;white-space:pre;font-family:${fontFamily};font-size:${fontSize}px;`;
    span.textContent = 'WWWWWWWWWW';
    document.body.appendChild(span);
    const rect = span.getBoundingClientRect();
    const cellW = rect.width / 10;
    const cellH = rect.height * (this.term.options?.lineHeight || 1.2);
    document.body.removeChild(span);
    if (cellW === 0 || cellH === 0) return null;

    const pad = 8;
    const cols = Math.max(2, Math.floor((container.clientWidth - pad) / cellW));
    const rows = Math.max(1, Math.floor((container.clientHeight - pad) / cellH));

    if (cols !== this.cols || rows !== this.rows) {
      this.term.resize(cols, rows);
      this.cols = cols;
      this.rows = rows;
      return { cols, rows };
    }
    return null;
  }

  startObserving() {
    const container = document.getElementById(this.containerId);
    if (!container) return;
    this._observer = new ResizeObserver(() => {
      if (this._resizeRAF) cancelAnimationFrame(this._resizeRAF);
      this._resizeRAF = requestAnimationFrame(() => {
        const dims = this.fit();
        if (dims && port) {
          port.postMessage({ type: 'pty_resize', session: this.sessionId, rows: dims.rows, cols: dims.cols });
        }
      });
    });
    this._observer.observe(container);
  }

  focus() {
    if (this.term) {
      this.term.focus();
      // Schedule a fit after focus in case container was hidden
      setTimeout(() => {
        const dims = this.fit();
        if (dims && port) {
          port.postMessage({ type: 'pty_resize', session: this.sessionId, rows: dims.rows, cols: dims.cols });
        }
      }, 50);
    }
  }
}

// ─── Create Both Sessions ────────────────────────────────────────────────────
const session1 = new TerminalSession(1, 'terminal-container-1');
const session2 = new TerminalSession(2, 'terminal-container-2');
let activeSession = 1; // Which terminal is "active" (receives focus)
let viewMode = 't1'; // 't1', 't2', 'split'

// ─── Connection ──────────────────────────────────────────────────────────────
let port = null;
let requestCounter = 0;
const pendingCallbacks = new Map();
const pendingRagbotRequests = new Map();
const MAX_PENDING_CALLBACKS = 100;
const RAGBOT_RESPONSE_TIMEOUT_MS = 30000;
const RAGBOT_RESPONSE_SETTLE_MS = 150;

function getActiveTerm() {
  return activeSession === 1 ? session1.term : session2.term;
}

function getActiveSession() {
  return activeSession === 1 ? session1 : session2;
}

// ─── Tom / Ragbot ────────────────────────────────────────────────────────────

function isTomThinkingText(text) {
  return /\*\*[^*]+\*\*/.test(text);
}

function normalizeTomText(text) {
  return String(text || '').replace(/\*\*(.*?)\*\*/g, '$1').trim();
}

function wordWrap(text, maxCols) {
  if (!maxCols || maxCols < 10) return text;
  const lines = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.length <= maxCols) { lines.push(paragraph); continue; }
    const words = paragraph.split(/(\s+)/);
    let line = '';
    for (const word of words) {
      if (line.length + word.length > maxCols && line.length > 0) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line += word;
      }
    }
    if (line) lines.push(line.trimEnd());
  }
  return lines.join('\r\n');
}

function formatTomLine(text) {
  const cols = getActiveSession().cols || 80;
  const normalized = normalizeTomText(text);
  const wrapped = wordWrap(normalized, Math.max(cols - 7, 10));
  if (isTomThinkingText(text)) {
    return `\x1b[1;36m[Tom]\x1b[0m \x1b[2m${wrapped}\x1b[0m`;
  }
  return `\x1b[1;36m[Tom]\x1b[0m ${wrapped}`;
}

function completeRagbotRequest(requestId, payload) {
  const pending = pendingRagbotRequests.get(requestId);
  if (!pending) return;
  if (pending.flushTimer) clearTimeout(pending.flushTimer);
  if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer);
  pendingRagbotRequests.delete(requestId);
  if (port) {
    port.postMessage({ type: 'ragbot_response', requestId, ...payload });
  }
}

function failAllPendingRagbotRequests(error) {
  const requestIds = [...pendingRagbotRequests.keys()];
  requestIds.forEach((requestId) => {
    completeRagbotRequest(requestId, { success: false, error });
  });
}

function routeTomTextToPendingRequest(text) {
  const next = pendingRagbotRequests.entries().next();
  if (next.done) return;
  const [requestId, pending] = next.value;
  const normalized = normalizeTomText(text);
  if (!normalized) return;
  pending.buffer = pending.buffer ? `${pending.buffer}\n${normalized}` : normalized;
  if (pending.flushTimer) clearTimeout(pending.flushTimer);
  pending.flushTimer = setTimeout(() => {
    completeRagbotRequest(requestId, {
      success: true,
      result: { text: pending.buffer.trim() }
    });
  }, RAGBOT_RESPONSE_SETTLE_MS);
}

async function handleRagbotRequest(msg) {
  if (!msg.requestId) return;
  if (!liveSession || liveSession.getState() !== 'connected') {
    if (port) {
      port.postMessage({
        type: 'ragbot_response',
        requestId: msg.requestId,
        success: false,
        error: 'Tom is not connected'
      });
    }
    return;
  }

  pendingRagbotRequests.set(msg.requestId, {
    buffer: '',
    flushTimer: null,
    timeoutTimer: setTimeout(() => {
      completeRagbotRequest(msg.requestId, {
        success: false,
        error: 'Tom did not respond in time'
      });
    }, RAGBOT_RESPONSE_TIMEOUT_MS)
  });

  const sent = await liveSession.sendText(msg.query || '');
  if (!sent) {
    completeRagbotRequest(msg.requestId, {
      success: false,
      error: 'Failed to send request to Tom'
    });
  }
}

function handleTomMessage(text) {
  // Tom messages go to session 1 terminal
  session1.term.writeln(formatTomLine(text));
  session1.term.scrollToBottom?.();
  routeTomTextToPendingRequest(text);
}

// ─── Connection ──────────────────────────────────────────────────────────────

function connect() {
  try {
    port = chrome.runtime.connect({ name: 'floyd-tty-panel' });

    port.onMessage.addListener(async (msg) => {
      if (msg.type === 'pty_output') {
        // Route to correct terminal by session
        const sess = msg.session === 2 ? session2 : session1;
        sess.term.write(msg.data);
      } else if (msg.type === 'tool_response') {
        if (msg.requestId && pendingCallbacks.has(msg.requestId)) {
          pendingCallbacks.get(msg.requestId)(msg);
          pendingCallbacks.delete(msg.requestId);
        }
      } else if (msg.type === 'ragbot_request') {
        await handleRagbotRequest(msg);
      } else if (msg.type === 'system_event') {
        handleSystemEvent(msg);
      }
    });

    port.onDisconnect.addListener(() => {
      failAllPendingRagbotRequests('Side panel disconnected');
      port = null;
      setStatus('disconnected', 'DISCONNECTED');
      session1.term.writeln('\r\n\x1b[31;1m[DISCONNECTED]\x1b[0m');
    });
  } catch (err) {
    console.error('[Floyd] Connection failed:', err);
    setStatus('error', 'CONNECTION FAILED');
  }
}

function handleSystemEvent(msg) {
  switch (msg.event) {
    case 'panel_ready':
      setStatus(msg.nativeConnected ? 'connected' : 'connecting',
                msg.nativeConnected ? 'CONNECTED' : 'CONNECTING...');
      break;
    case 'native_connected': {
      const sessNum = msg.session || 1;
      const sess = sessNum === 2 ? session2 : session1;
      setStatus('connected', 'CONNECTED');
      sess.term.writeln(`\x1b[32;1m[Native Host ${sessNum} Connected]\x1b[0m`);
      setTimeout(() => sess.fit(), 100);
      break;
    }
    case 'context_captured':
      showToast('Context captured');
      break;
    case 'native_disconnected': {
      const dn = msg.session || 0;
      if (dn === 2) {
        session2.term.writeln('\x1b[31;1m[T2 native disconnected]\x1b[0m');
      } else if (dn === 1) {
        session1.term.writeln('\x1b[31;1m[T1 native disconnected]\x1b[0m');
      }
      failAllPendingRagbotRequests('Native host disconnected');
      break;
    }
  }
}

// ─── Input Handling ──────────────────────────────────────────────────────────

const CHUNK_SIZE = 8192;

function setupTerminalInput(session) {
  session.term.onData((data) => {
    if (!port) return;
    if (data.length <= CHUNK_SIZE) {
      try { port.postMessage({ type: 'pty_input', data, session: session.sessionId }); } catch (_) {}
    } else {
      let offset = 0;
      const sendChunk = () => {
        if (offset < data.length && port) {
          const chunk = data.substring(offset, offset + CHUNK_SIZE);
          try { port.postMessage({ type: 'pty_input', data: chunk, session: session.sessionId }); } catch (_) {}
          offset += CHUNK_SIZE;
          setTimeout(sendChunk, 0);
        }
      };
      sendChunk();
    }
  });
}

setupTerminalInput(session1);
setupTerminalInput(session2);

// ─── Focus Management ────────────────────────────────────────────────────────

function setActiveSession(num) {
  activeSession = num;
  const c1 = document.getElementById('terminal-container-1');
  const c2 = document.getElementById('terminal-container-2');
  c1.classList.toggle('focused', num === 1);
  c2.classList.toggle('focused', num === 2);
  (num === 1 ? session1 : session2).focus();
}

document.getElementById('terminal-container-1')?.addEventListener('mousedown', () => {
  setTimeout(() => setActiveSession(1), 10);
});
document.getElementById('terminal-container-2')?.addEventListener('mousedown', () => {
  setTimeout(() => setActiveSession(2), 10);
});

window.addEventListener('click', (e) => {
  const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable;
  if (!isInput) {
    getActiveSession().focus();
  }
});

// ─── View Switching ──────────────────────────────────────────────────────────

function setView(mode) {
  viewMode = mode;
  const c1 = document.getElementById('terminal-container-1');
  const c2 = document.getElementById('terminal-container-2');
  const divider = document.getElementById('split-divider');
  const tabs = document.querySelectorAll('.session-tab');
  const statusEl = document.getElementById('session-status');

  // Reset tab styles
  tabs.forEach(t => { t.classList.remove('active', 'split-active'); });

  if (mode === 't1') {
    c1.classList.remove('hidden');
    c2.classList.add('hidden');
    divider.style.display = 'none';
    c1.style.flex = '1';
    document.getElementById('tab-t1').classList.add('active');
    statusEl.textContent = 'T1 active';
    setActiveSession(1);
  } else if (mode === 't2') {
    c1.classList.add('hidden');
    c2.classList.remove('hidden');
    divider.style.display = 'none';
    c2.style.flex = '1';
    document.getElementById('tab-t2').classList.add('active');
    statusEl.textContent = 'T2 active';
    setActiveSession(2);
    // Request session 2 native host if not already connected
    if (port) port.postMessage({ type: 'request_session', session: 2 });
  } else if (mode === 'split') {
    c1.classList.remove('hidden');
    c2.classList.remove('hidden');
    divider.style.display = 'block';
    c1.style.flex = '1';
    c2.style.flex = '1';
    document.getElementById('tab-split').classList.add('split-active');
    statusEl.textContent = 'SPLIT';
    // Request session 2 native host if not already connected
    if (port) port.postMessage({ type: 'request_session', session: 2 });
    setActiveSession(1);
  }

  // Refit both visible terminals after layout settles
  requestAnimationFrame(() => {
    if (mode !== 't2') {
      const d1 = session1.fit();
      if (d1 && port) port.postMessage({ type: 'pty_resize', session: 1, rows: d1.rows, cols: d1.cols });
    }
    if (mode !== 't1') {
      const d2 = session2.fit();
      if (d2 && port) port.postMessage({ type: 'pty_resize', session: 2, rows: d2.rows, cols: d2.cols });
    }
  });
}

document.querySelectorAll('.session-tab')?.forEach(tab => {
  tab.addEventListener('click', () => {
    const view = tab.dataset.view;
    if (view) setView(view);
  });
});

// ─── Split Divider Dragging ──────────────────────────────────────────────────

(function setupDividerDrag() {
  const divider = document.getElementById('split-divider');
  const area = document.getElementById('terminal-area');
  const c1 = document.getElementById('terminal-container-1');
  const c2 = document.getElementById('terminal-container-2');
  let dragging = false;

  divider.addEventListener('mousedown', (e) => {
    if (viewMode !== 'split') return;
    dragging = true;
    divider.classList.add('dragging');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const areaRect = area.getBoundingClientRect();
    const dividerH = divider.offsetHeight;
    const relY = e.clientY - areaRect.top;
    const totalH = areaRect.height - dividerH;
    const pct = Math.max(0.15, Math.min(0.85, relY / areaRect.height));
    c1.style.flex = 'none';
    c2.style.flex = 'none';
    c1.style.height = (pct * totalH) + 'px';
    c2.style.height = ((1 - pct) * totalH) + 'px';
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('dragging');
    // Refit both terminals
    requestAnimationFrame(() => {
      const d1 = session1.fit();
      if (d1 && port) port.postMessage({ type: 'pty_resize', session: 1, rows: d1.rows, cols: d1.cols });
      const d2 = session2.fit();
      if (d2 && port) port.postMessage({ type: 'pty_resize', session: 2, rows: d2.rows, cols: d2.cols });
    });
  });
})();

// ─── UI Utilities ────────────────────────────────────────────────────────────

function setStatus(state, text) {
  const dot = document.getElementById('native-dot');
  const label = document.getElementById('status-text');
  if (dot) dot.className = 'status-dot ' + state;
  if (label) label.textContent = text;
}

function showToast(message) {
  const toast = document.getElementById('error-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 3000);
}

// ─── Tool Call Infrastructure ────────────────────────────────────────────────

function sendToolCall(tool, args = {}) {
  const requestId = 'panel_' + (++requestCounter) + '_' + Date.now();
  return new Promise((resolve) => {
    if (pendingCallbacks.size >= MAX_PENDING_CALLBACKS) {
      const oldest = pendingCallbacks.keys().next().value;
      const oldCb = pendingCallbacks.get(oldest);
      pendingCallbacks.delete(oldest);
      if (oldCb) oldCb({ success: false, error: 'Evicted' });
    }
    pendingCallbacks.set(requestId, resolve);
    setTimeout(() => {
      if (pendingCallbacks.has(requestId)) {
        pendingCallbacks.delete(requestId);
        resolve({ success: false, error: 'Timeout' });
      }
    }, 30000);

    if (port) {
      port.postMessage({ type: 'tool_call', requestId, tool, args });
    } else {
      resolve({ success: false, error: 'Not connected' });
    }
  });
}

function writeToolResult(label, result) {
  const term = getActiveTerm();
  term.writeln('');
  term.writeln(`\x1b[1;35m--- ${label} ---\x1b[0m`);

  const json = JSON.stringify(result, null, 2);
  const lines = json.split('\n');
  for (const line of lines) {
    const colored = line
      .replace(/"([^"]+)":/g, '\x1b[36m"$1"\x1b[0m:')
      .replace(/: "([^"]+)"/g, ': \x1b[33m"$1"\x1b[0m')
      .replace(/: (\d+)/g, ': \x1b[32m$1\x1b[0m')
      .replace(/: (true|false)/g, ': \x1b[35m$1\x1b[0m');
    term.writeln(colored);
  }
  term.writeln(`\x1b[1;35m────────────────\x1b[0m`);
  term.writeln('');
}

// ─── Tool Buttons ────────────────────────────────────────────────────────────

document.getElementById('btn-analyze')?.addEventListener('click', async () => {
  const term = getActiveTerm();
  term.writeln('\x1b[1;33m[Analyzing page...]\x1b[0m');
  const result = await sendToolCall('analyze_page', { include_css: true, include_accessibility: true });
  if (result.success) {
    const r = result.result;
    term.writeln(`\x1b[1;32m[Page Analysis Complete]\x1b[0m`);
    term.writeln(`  URL: \x1b[36m${r.url}\x1b[0m`);
    term.writeln(`  Title: ${r.title}`);
    term.writeln(`  Score: \x1b[${r.score >= 80 ? '32' : r.score >= 50 ? '33' : '31'}m${r.score}/100\x1b[0m`);
    term.writeln(`  Landmarks: ${Object.keys(r.landmarks || {}).length} | Headings: ${r.headings?.length || 0}`);
    term.writeln(`  Issues: ${r.technical_issues?.length || 0} technical, ${r.accessibility?.violations_count || 0} a11y`);
    term.writeln(`  Interactive: ${r.interactive_elements?.length || 0} elements`);
    if (r.technical_issues?.length > 0) {
      term.writeln(`\x1b[1;31m  Technical Issues:\x1b[0m`);
      r.technical_issues.forEach(i => { term.writeln(`    - ${i}`); });
    }
  } else {
    term.writeln(`\x1b[1;31m[Error: ${result.error}]\x1b[0m`);
  }
});

document.getElementById('btn-dom')?.addEventListener('click', async () => {
  const term = getActiveTerm();
  term.writeln('\x1b[1;33m[Fetching DOM tree...]\x1b[0m');
  const result = await sendToolCall('analyze_page', { include_css: false, include_accessibility: false });
  if (result.success) {
    writeToolResult('DOM Structure', {
      landmarks: result.result.landmarks,
      headings: result.result.headings,
      forms: result.result.forms,
      interactive: result.result.interactive_elements?.slice(0, 15),
    });
  } else {
    term.writeln(`\x1b[1;31m[Error: ${result.error}]\x1b[0m`);
  }
});

document.getElementById('btn-a11y')?.addEventListener('click', async () => {
  const term = getActiveTerm();
  term.writeln('\x1b[1;33m[Running accessibility audit...]\x1b[0m');
  const result = await sendToolCall('check_accessibility', { level: 'AA' });
  if (result.success) {
    const r = result.result;
    term.writeln(`\x1b[1;${r.violations_count === 0 ? '32' : '31'}m[A11Y Audit: ${r.violations_count} violations (WCAG ${r.level_checked})]\x1b[0m`);
    (r.violations || []).forEach(v => {
      const color = v.severity === 'serious' ? '31' : '33';
      term.writeln(`  \x1b[${color}m[${v.severity}]\x1b[0m ${v.rule}`);
      term.writeln(`    Element: \x1b[36m${v.element}\x1b[0m`);
      term.writeln(`    Fix: ${v.fix}`);
    });
  } else {
    term.writeln(`\x1b[1;31m[Error: ${result.error}]\x1b[0m`);
  }
});

document.getElementById('btn-screenshot')?.addEventListener('click', async () => {
  const term = getActiveTerm();
  term.writeln('\x1b[1;33m[Capturing screenshot...]\x1b[0m');
  const result = await sendToolCall('take_screenshot', {});
  if (result.success) {
    term.writeln(`\x1b[1;32m[Screenshot captured]\x1b[0m`);
    term.writeln(`  Format: ${result.result.format}`);
    term.writeln(`  Size: ${Math.round(result.result.screenshot?.length / 1024)}KB base64`);
  } else {
    term.writeln(`\x1b[1;31m[Error: ${result.error}]\x1b[0m`);
  }
});

// ─── Vision Overlay Toggle ───────────────────────────────────────────────────
// Same path as the Cmd+Shift+E hotkey: message the active tab's content script.
// Lives in the panel so it works even when the OS-level shortcut isn't bound.
let visionOn = false;

document.getElementById('btn-vision')?.addEventListener('click', async () => {
  const term = getActiveTerm();
  const btn = document.getElementById('btn-vision');
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) {
      term.writeln('\x1b[1;31m[Vision: no active tab]\x1b[0m');
      return;
    }
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle_vision_overlay' });
    visionOn = !visionOn;
    btn?.classList.toggle('media-active', visionOn);
    term.writeln(`\x1b[1;32m[Vision overlay ${visionOn ? 'ON' : 'OFF'}]\x1b[0m`);
  } catch (err) {
    // No content script on this tab (chrome://, Web Store, PDF viewer, or a tab
    // opened before the extension loaded). Reloading the page injects it.
    term.writeln('\x1b[1;31m[Vision: content script not present on this tab — reload the page and try again. chrome:// and Web Store pages are not supported.]\x1b[0m');
  }
});

// ─── Gemini Live Session ─────────────────────────────────────────────────────

let liveSession = null;
let audioStream = null;

async function liveToolExecutor(toolName, args) {
  const executor = (globalThis.__floydSidepanelTest && globalThis.__floydSidepanelTest.sendToolCall) || sendToolCall;
  const result = await executor(toolName, args);
  if (result.success) {
    if (result.result && result.result.floyd_command) {
      let cmd = result.result.floyd_command;
      if (typeof cmd === 'object') cmd = cmd.command || JSON.stringify(cmd);
      if (!cmd.endsWith('\n')) cmd += '\n';
      if (port) {
        port.postMessage({ type: 'pty_input', data: cmd, session: 1 });
        session1.term.writeln(`\r\n\x1b[35;1m[Tom suggested: ${cmd.trim()}]\x1b[0m`);
      }
    }
    return result.result;
  }
  throw new Error(result.error || 'Tool call failed');
}

document.getElementById('btn-live')?.addEventListener('click', async () => {
  const btnLive = document.getElementById('btn-live');

  if (!LiveSession) {
    showToast('Gemini Live not available');
    return;
  }

  if (liveSession && liveSession.getState() !== 'idle') {
    session1.term.writeln('\x1b[1;33m[Disconnecting Gemini Live...]\x1b[0m');
    liveSession.disconnect();
    btnLive.classList.remove('live-active');
    btnLive.textContent = 'LIVE';
    document.getElementById('btn-screen').classList.remove('media-active');
    document.getElementById('btn-camera').classList.remove('media-active');
    if (audioStream) {
      audioStream.getTracks().forEach(t => { t.stop(); });
      audioStream = null;
    }
    session1.term.writeln('\x1b[1;32m[Live session ended]\x1b[0m');
    updateTomInputVisibility();
    return;
  }

  const data = await chrome.storage.local.get(['gemini_api_key', 'live_voice']);
  if (!data.gemini_api_key) {
    showToast('Set your Gemini API key first');
    document.getElementById('settings-modal').classList.add('visible');
    return;
  }

  session1.term.writeln('\x1b[1;33m[Starting Gemini Live session...]\x1b[0m');
  btnLive.classList.add('live-active');
  btnLive.textContent = 'STOP';

  try {
    const micState = await navigator.permissions.query({ name: 'microphone' });
    session1.term.writeln(`\x1b[1;33m[Mic: ${micState.state}]\x1b[0m`);

    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });

    liveSession = new LiveSession(
      (text) => { handleTomMessage(text); },
      () => {},
      (error) => {
        failAllPendingRagbotRequests(error.message || JSON.stringify(error));
        session1.term.writeln(`\x1b[1;31m[Live Error: ${error.message || JSON.stringify(error)}]\x1b[0m`);
        if (!error.retrying) {
          btnLive.classList.remove('live-active');
          btnLive.textContent = 'LIVE';
        }
      },
      (status) => {
        const colors = { idle: '90', connecting: '33', connected: '32', reconnecting: '33', disconnecting: '31' };
        session1.term.writeln(`\x1b[${colors[status] || '0'}m[Live: ${status}]\x1b[0m`);
        if (status === 'idle') {
          failAllPendingRagbotRequests('Tom session ended');
          btnLive.classList.remove('live-active');
          btnLive.textContent = 'LIVE';
          document.getElementById('btn-screen').classList.remove('media-active');
          document.getElementById('btn-camera').classList.remove('media-active');
        }
        updateTomInputVisibility();
      },
      liveToolExecutor
    );

    await liveSession.connect(audioStream, undefined, { voice: data.live_voice || 'Puck' });
    session1.term.writeln('\x1b[1;32m[Live connected — speak or type to Tom]\x1b[0m');
    updateTomInputVisibility();
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      session1.term.writeln('\x1b[1;31m[Microphone blocked]\x1b[0m Allow mic in Chrome address bar.');
    } else {
      session1.term.writeln(`\x1b[1;31m[Live failed: ${err.name}: ${err.message}]\x1b[0m`);
    }
    btnLive.classList.remove('live-active');
    btnLive.textContent = 'LIVE';
    if (audioStream) {
      audioStream.getTracks().forEach(t => { t.stop(); });
      audioStream = null;
    }
  }
});

// ─── Tom Text Input ──────────────────────────────────────────────────────────
const tomInputBar = document.getElementById('tom-input-bar');
const tomInput = document.getElementById('tom-input');
const tomSendBtn = document.getElementById('tom-send-btn');

async function sendTomText() {
  const text = tomInput.value.trim();
  if (!text) return;
  if (!liveSession || liveSession.getState() !== 'connected') {
    showToast('Live session not connected');
    return;
  }
  tomInput.value = '';
  const cols = session1.cols || 80;
  const w = wordWrap(text, cols - 7);
  session1.term.writeln(`\x1b[1;33m[You]\x1b[0m ${w}`);
  session1.term.scrollToBottom();
  const sent = await liveSession.sendText(text);
  if (!sent) {
    session1.term.writeln('\x1b[1;31m[Failed to send]\x1b[0m');
  }
}

tomInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendTomText();
  }
});
tomSendBtn?.addEventListener('click', sendTomText);

function updateTomInputVisibility() {
  if (!tomInputBar) return;
  const connected = liveSession && liveSession.getState() === 'connected';
  tomInputBar.classList.toggle('visible', connected);
  if (connected) tomInput?.focus();
  // Refit after layout change
  requestAnimationFrame(() => {
    if (viewMode !== 't2') session1.fit();
    if (viewMode !== 't1') session2.fit();
  });
}

// ─── Screen / Camera ─────────────────────────────────────────────────────────

document.getElementById('btn-screen')?.addEventListener('click', async () => {
  const btnScreen = document.getElementById('btn-screen');
  if (!liveSession || liveSession.getState() !== 'connected') {
    showToast('Start a Live session first');
    return;
  }
  if (btnScreen.classList.contains('media-active')) {
    liveSession.stopVideoStream();
    btnScreen.classList.remove('media-active');
    session1.term.writeln('\x1b[1;33m[Screen sharing stopped]\x1b[0m');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', cursor: 'always' }
    });
    liveSession.startVideoStream(stream);
    btnScreen.classList.add('media-active');
    document.getElementById('btn-camera').classList.remove('media-active');
    session1.term.writeln('\x1b[1;32m[Screen sharing active]\x1b[0m');
    stream.getVideoTracks()[0].onended = () => {
      liveSession.stopVideoStream();
      btnScreen.classList.remove('media-active');
      session1.term.writeln('\x1b[1;33m[Screen sharing ended]\x1b[0m');
    };
  } catch (err) {
    session1.term.writeln(`\x1b[1;31m[Screen share failed: ${err.message}]\x1b[0m`);
  }
});

document.getElementById('btn-camera')?.addEventListener('click', async () => {
  const btnCamera = document.getElementById('btn-camera');
  if (!liveSession || liveSession.getState() !== 'connected') {
    showToast('Start a Live session first');
    return;
  }
  if (btnCamera.classList.contains('media-active')) {
    liveSession.stopVideoStream();
    btnCamera.classList.remove('media-active');
    session1.term.writeln('\x1b[1;33m[Camera stopped]\x1b[0m');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    liveSession.startVideoStream(stream);
    btnCamera.classList.add('media-active');
    document.getElementById('btn-screen').classList.remove('media-active');
    session1.term.writeln('\x1b[1;32m[Camera active]\x1b[0m');
    stream.getVideoTracks()[0].onended = () => {
      liveSession.stopVideoStream();
      btnCamera.classList.remove('media-active');
      session1.term.writeln('\x1b[1;33m[Camera stopped]\x1b[0m');
    };
  } catch (err) {
    session1.term.writeln(`\x1b[1;31m[Camera failed: ${err.message}]\x1b[0m`);
  }
});

// ─── Settings ────────────────────────────────────────────────────────────────

document.getElementById('btn-settings')?.addEventListener('click', async () => {
  const modal = document.getElementById('settings-modal');
  const keyInput = document.getElementById('input-api-key');
  const voiceInput = document.getElementById('input-voice');
  const data = await chrome.storage.local.get(['gemini_api_key', 'live_voice']);
  keyInput.value = data.gemini_api_key || '';
  voiceInput.value = data.live_voice || 'Puck';
  modal.classList.add('visible');
});

document.getElementById('btn-settings-save')?.addEventListener('click', async () => {
  const key = document.getElementById('input-api-key').value.trim();
  const voice = document.getElementById('input-voice').value.trim() || 'Puck';
  await chrome.storage.local.set({ gemini_api_key: key, live_voice: voice });
  document.getElementById('settings-modal').classList.remove('visible');
  showToast('Settings saved');
  session1.term.writeln(`\x1b[1;32m[Settings saved — key ${key ? 'set' : 'cleared'}, voice: ${voice}]\x1b[0m`);
});

document.getElementById('btn-settings-cancel')?.addEventListener('click', () => {
  document.getElementById('settings-modal').classList.remove('visible');
});

document.getElementById('settings-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'settings-modal') {
    document.getElementById('settings-modal').classList.remove('visible');
  }
});

document.getElementById('btn-reconnect')?.addEventListener('click', () => {
  session1.term.writeln('\x1b[1;33m[Reconnecting...]\x1b[0m');
  if (port) port.disconnect();
  setTimeout(connect, 500);
});

document.getElementById('btn-reload')?.addEventListener('click', () => {
  session1.term.writeln('\x1b[1;31m[Reloading extension...]\x1b[0m');
  setTimeout(() => chrome.runtime.reload(), 200);
});

// ─── File Proxy (for external tool calls via ~/floyd_comm) ───────────────────
let isPolling = false;
async function pollFileProxy() {
  if (!port || isPolling) return;
  isPolling = true;
  try {
    const readRes = await sendToolCall('execute_shell', {
      command: 'cat "$HOME/floyd_comm/cmd.json" 2>/dev/null || echo "NONE"'
    });
    if (readRes.success && readRes.result.stdout && readRes.result.stdout.trim() !== 'NONE') {
      const cmd = JSON.parse(readRes.result.stdout);
      if (cmd && cmd.pending) {
        session1.term.writeln(`\x1b[33m[Proxy]: ${cmd.tool}...\x1b[0m`);
        let result;
        try {
          result = await liveToolExecutor(cmd.tool, cmd.args || {});
        } catch (e) {
          result = { error: e.message };
        }
        const resp = JSON.stringify({ id: cmd.id, result, ts: Date.now() });
        await sendToolCall('execute_shell', {
          command: `echo '${resp.replace(/'/g, "'\\''")}' > "$HOME/floyd_comm/resp.json" && echo "DONE" > "$HOME/floyd_comm/cmd.json"`
        });
        session1.term.writeln(`\x1b[32m[Proxy]: Done.\x1b[0m`);
      }
    }
  } catch (_) {}
  finally { isPolling = false; }
}
setInterval(pollFileProxy, 2000);

// ─── Test Hook ───────────────────────────────────────────────────────────────

if (globalThis.__FLOYD_TEST__) {
  globalThis.__floydSidepanelTest = {
    handleRagbotRequest,
    sendToolCall,
    liveToolExecutor,
    session1,
    session2,
    setLiveSession(s) { liveSession = s; },
    setPort(p) { port = p; }
  };
}

// ─── Boot ────────────────────────────────────────────────────────────────────

session1.term.writeln('\x1b[1;32m╔══════════════════════════════════════╗\x1b[0m');
session1.term.writeln('\x1b[1;32m║\x1b[0m  \x1b[1;37mFloyd\'s Labs TTY Bridge\x1b[0m \x1b[1;35mv5.1.0\x1b[0m    \x1b[1;32m║\x1b[0m');
session1.term.writeln('\x1b[1;32m║\x1b[0m  \x1b[90mDual Terminal • Responsive UI\x1b[0m       \x1b[1;32m║\x1b[0m');
session1.term.writeln('\x1b[1;32m╚══════════════════════════════════════╝\x1b[0m');
session1.term.writeln('\x1b[90mT1 ready. Use tabs above for T2 or SPLIT view.\x1b[0m');

session2.term.writeln('\x1b[1;36m╔══════════════════════════════════════╗\x1b[0m');
session2.term.writeln('\x1b[1;36m║\x1b[0m  \x1b[1;37mTerminal 2\x1b[0m \x1b[90m— Vision / Tools\x1b[0m        \x1b[1;36m║\x1b[0m');
session2.term.writeln('\x1b[1;36m╚══════════════════════════════════════╝\x1b[0m');
session2.term.writeln('\x1b[90mReady for connection...\x1b[0m');

connect();

// Start resize observers after connection
session1.startObserving();
session2.startObserving();

// Initial fit
requestAnimationFrame(() => {
  session1.fit();
});
