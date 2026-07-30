// CURSE'M IDE — TerminalOne Adapter (§6).
//
// §6: "TerminalOne is the only terminal implementation."
// §6: "Do not create another node-pty server."
// §6: "Do not ship a separate xterm-based backend."
// §6: "Embed the TerminalOne client or consume a reusable TerminalOne component."
// §6: "New terminals open in the active Floyd workspace."
// §6: "Terminal sessions remain available when switching between IDE and terminal views."
// §6: "Support multiple sessions, resize, clipboard, mobile key bar, search, and reconnect."
// §6: "Terminal authorization must come from the Floyd platform gateway."
// §6: "The IDE must never expose an unauthenticated PTY to the network."
//
// TerminalOne is a local application. The IDE connects to it via a bridge
// endpoint (WebSocket). The IDE uses xterm.js for RENDERING ONLY — it does
// NOT create a PTY or terminal backend. All PTY processes are owned by
// TerminalOne.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import type { HostGateway, TerminalAuth, TerminalOneSession } from '@/platform';
import type { TerminalRendererTheme } from '@/theme';

interface SessionState {
  ws: WebSocket | null;
  term: Terminal | null;
  fit: FitAddon | null;
  search: SearchAddon | null;
  sessionId: string | null;
  cwd: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'error';
  pid?: number;
  outputCallbacks: Set<(data: string) => void>;
  exitCallbacks: Set<(code: number) => void>;
  inputBuffer: string;
  inputFlushTimer: ReturnType<typeof setTimeout> | null;
  inputDataListener?: { dispose: () => void } | null;
  resizeObserver?: ResizeObserver | null;
  resizeElement?: HTMLElement | null;
  outputHandler?: ((data: string) => void) | null;
}

interface TerminalOneMessage {
  type: string;
  data?: string;
  code?: number | string;
  message?: string;
}

const INPUT_BATCH_INTERVAL_MS = 12;
const INPUT_BATCH_CHUNK_SIZE = 4096;

export class TerminalOneAdapter {
  private gateway: HostGateway;
  private auth: TerminalAuth | null = null;
  private sessions = new Map<string, SessionState>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private rendererTheme: TerminalRendererTheme;
  private rendererFontFamily: string;

  constructor(gateway: HostGateway, rendererTheme?: TerminalRendererTheme, rendererFontFamily = '"Phantasy Mono PTY", "JetBrains Mono", Menlo, monospace') {
    this.gateway = gateway;
    this.rendererFontFamily = rendererFontFamily;
    this.rendererTheme = rendererTheme ?? {
      background: '#0B0912', foreground: '#E9E7EE', cursor: '#25D9F5', cursorAccent: '#0B0912',
      selectionBackground: '#4F234F', black: '#08070D', red: '#FF6B83', green: '#51D59A',
      yellow: '#F4C464', blue: '#73B9FF', magenta: '#FF5FA2', cyan: '#25D9F5', white: '#EBE8EF',
    };
  }

  setRendererTheme(theme: TerminalRendererTheme): void {
    this.rendererTheme = theme;
    for (const state of this.sessions.values()) {
      if (state.term) state.term.options.theme = theme;
    }
  }

  setRendererFontFamily(fontFamily: string): void {
    this.rendererFontFamily = fontFamily;
    for (const state of this.sessions.values()) {
      if (state.term) state.term.options.fontFamily = fontFamily;
    }
  }

  /** Open the Floyd-authorized TerminalOne bridge. */
  private openSocket(auth: TerminalAuth): WebSocket {
    return new WebSocket(auth.endpoint, auth.token ? [auth.token] : undefined);
  }

  /** Apply messages shared by fresh, resumed, and reconnected sessions. */
  private applySessionMessage(state: SessionState, msg: TerminalOneMessage): void {
    if (msg.type === 'output' && typeof msg.data === 'string') {
      for (const cb of state.outputCallbacks) {
        try { cb(msg.data); } catch {}
      }
    } else if (msg.type === 'shell-reset') {
      const code = typeof msg.code === 'number' ? msg.code : 0;
      for (const cb of state.exitCallbacks) {
        try { cb(code); } catch {}
      }
    } else if (msg.type === 'error' || msg.type === 'resume-failed') {
      state.status = 'error';
    }
  }

  /** Get authorization from Floyd platform gateway (§6). */
  private async ensureAuth(): Promise<TerminalAuth> {
    if (this.auth && this.auth.expiresAt > Date.now()) {
      return this.auth;
    }
    this.auth = await this.gateway.terminalAuth();
    return this.auth;
  }

  /**
   * Create a new terminal session (§6: "New terminals open in the active Floyd workspace").
   * Returns a session ID. The actual PTY is owned by TerminalOne.
   */
  async createSession(cwd: string, cols: number, rows: number): Promise<TerminalOneSession> {
    const auth = await this.ensureAuth();

    const ws = this.openSocket(auth);
    const state: SessionState = {
      ws,
      term: null,
      fit: null,
      search: null,
      sessionId: null,
      cwd,
      status: 'connecting',
      outputCallbacks: new Set(),
      exitCallbacks: new Set(),
      inputBuffer: '',
      inputFlushTimer: null,
      inputDataListener: null,
      resizeObserver: null,
      resizeElement: null,
      outputHandler: null,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Terminal connection timeout'));
      }, 10000);

      ws.onopen = () => {
        // TerminalOne creates a PTY when it receives the shell message.
        ws.send(JSON.stringify({
          type: 'shell',
          cols,
          rows,
          cwd,
        }));
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'ready') {
            clearTimeout(timeout);
            state.sessionId = msg.sessionId;
            state.pid = msg.pid;
            state.status = 'connected';
            this.sessions.set(msg.sessionId, state);

            resolve({
              id: msg.sessionId,
              title: cwd.split('/').pop() || 'terminal',
              cwd,
              status: 'connected',
              pid: msg.pid,
            });
          } else {
            this.applySessionMessage(state, msg);
          }
        } catch {}
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        state.status = 'error';
        reject(new Error('Terminal connection failed'));
      };

      ws.onclose = () => {
        if (state.status !== 'disconnected') {
          state.status = 'disconnected';
        }
      };
    });
  }

  /**
   * Resume an existing terminal session (§6: "Terminal sessions remain
   * available when switching between IDE and terminal views").
   */
  async resumeSession(sessionId: string, cols: number, rows: number): Promise<TerminalOneSession> {
    const auth = await this.ensureAuth();
    const existing = this.sessions.get(sessionId);

    if (existing && existing.status === 'connected') {
      existing.ws?.send(JSON.stringify({ type: 'resize', cols, rows }));
      return {
        id: sessionId,
        title: existing.cwd.split('/').pop() || 'terminal',
        cwd: existing.cwd,
        status: 'connected',
      };
    }

    // Reconnect to TerminalOne with existing session ID
    const ws = this.openSocket(auth);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Resume timeout')), 10000);

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'resume',
          sessionId,
          cols,
          rows,
        }));
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'ready') {
            clearTimeout(timeout);
            const state = this.sessions.get(sessionId);
            if (state) {
              state.ws = ws;
              state.cwd = msg.cwd || state.cwd;
              state.status = 'connected';
            }
            resolve({
              id: sessionId,
              title: 'terminal',
              cwd: msg.cwd || '',
              status: 'connected',
              pid: msg.pid,
            });
          } else if (existing) {
            this.applySessionMessage(existing, msg);
          }
        } catch {}
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Resume failed'));
      };
    });
  }

  /**
   * Attach xterm.js renderer to a container (§6: rendering only, no backend).
   */
  attachRenderer(sessionId: string, container: HTMLElement): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    // Create xterm.js Terminal instance for rendering
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: this.rendererFontFamily,
      theme: this.rendererTheme,
    });

    const fit = new FitAddon();
    const search = new SearchAddon();
    const webLinks = new WebLinksAddon();

    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(webLinks);

    term.open(container);
    fit.fit();

    const dataListener = term.onData((data) => {
      this.queueInput(state, data);
    });
    state.inputDataListener = dataListener;

    // TerminalOne output → write to xterm.js
    const outputHandler = (data: string) => {
      term.write(data);
    };
    state.outputCallbacks.add(outputHandler);
    state.outputHandler = outputHandler;

    // Resize handling
    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      if (state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({
          type: 'resize',
          cols: term.cols,
          rows: term.rows,
        }));
      }
    });
    resizeObserver.observe(container);
    state.resizeObserver = resizeObserver;
    state.resizeElement = container;

    state.term = term;
    state.fit = fit;
    state.search = search;
  }

  /** Detach xterm.js renderer from a session. */
  detachRenderer(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (state.inputFlushTimer) {
      clearTimeout(state.inputFlushTimer);
      state.inputFlushTimer = null;
    }
    state.inputBuffer = '';
    if (state.inputDataListener?.dispose) {
      state.inputDataListener.dispose();
      state.inputDataListener = null;
    }
    if (state.outputHandler) {
      state.outputCallbacks.delete(state.outputHandler);
      state.outputHandler = null;
    }
    if (state.resizeObserver && state.resizeElement) {
      state.resizeObserver.unobserve(state.resizeElement);
      state.resizeObserver = null;
      state.resizeElement = null;
    }
    state.term?.dispose();
    state.term = null;
    state.fit = null;
    state.search = null;
  }

  /** Send input to terminal. */
  sendInput(sessionId: string, data: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.queueInput(state, data);
  }

  private queueInput(state: SessionState, data: string): void {
    if (!data) return;
    state.inputBuffer += data;

    if (state.inputFlushTimer) {
      if (state.inputBuffer.length >= INPUT_BATCH_CHUNK_SIZE) {
        clearTimeout(state.inputFlushTimer);
        state.inputFlushTimer = null;
        const payload = state.inputBuffer;
        state.inputBuffer = '';
        this.flushInput(state, payload);
      }
      return;
    }

    state.inputFlushTimer = setTimeout(() => {
      const payload = state.inputBuffer;
      state.inputBuffer = '';
      state.inputFlushTimer = null;
      this.flushInput(state, payload);
    }, INPUT_BATCH_INTERVAL_MS);
  }

  private flushInput(state: SessionState, data: string): void {
    if (!data || state.ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    for (let offset = 0; offset < data.length; offset += INPUT_BATCH_CHUNK_SIZE) {
      state.ws.send(JSON.stringify({
        type: 'input',
        data: data.substring(offset, offset + INPUT_BATCH_CHUNK_SIZE),
      }));
    }
  }

  /** Resize terminal. */
  resize(sessionId: string, cols: number, rows: number): void {
    const state = this.sessions.get(sessionId);
    if (state?.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }

  /** Kill a terminal session. */
  killSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'close' }));
      state.ws.close();
    }
    if (state.inputFlushTimer) {
      clearTimeout(state.inputFlushTimer);
      state.inputFlushTimer = null;
    }
    state.inputBuffer = '';
    if (state.inputDataListener?.dispose) {
      state.inputDataListener.dispose();
      state.inputDataListener = null;
    }
    if (state.outputHandler) {
      state.outputCallbacks.delete(state.outputHandler);
      state.outputHandler = null;
    }
    if (state.resizeObserver && state.resizeElement) {
      state.resizeObserver.unobserve(state.resizeElement);
      state.resizeObserver = null;
      state.resizeElement = null;
    }
    state.term?.dispose();
    state.term = null;
    state.fit = null;
    state.search = null;
    this.sessions.delete(sessionId);
  }

  /** Subscribe to terminal output. */
  onOutput(sessionId: string, callback: (data: string) => void): () => void {
    const state = this.sessions.get(sessionId);
    if (!state) return () => {};
    state.outputCallbacks.add(callback);
    return () => { state.outputCallbacks.delete(callback); };
  }

  /** Subscribe to terminal exit. */
  onExit(sessionId: string, callback: (code: number) => void): () => void {
    const state = this.sessions.get(sessionId);
    if (!state) return () => {};
    state.exitCallbacks.add(callback);
    return () => { state.exitCallbacks.delete(callback); };
  }

  /** Search in terminal (§6: "search"). */
  search(sessionId: string, query: string, direction: 'next' | 'prev' = 'next'): void {
    const state = this.sessions.get(sessionId);
    if (!state?.search) return;
    if (direction === 'next') {
      state.search.findNext(query);
    } else {
      state.search.findPrevious(query);
    }
  }

  /** Reconnect after disconnection (§6: "reconnect"). */
  async reconnect(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    state.status = 'reconnecting';

    if (state.ws) {
      state.ws.close();
      state.ws = null;
    }

    try {
      const auth = await this.ensureAuth();
      const ws = this.openSocket(auth);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Reconnect timeout')), 10000);

        ws.onopen = () => {
          ws.send(JSON.stringify({
            type: 'resume',
            sessionId,
            cols: state.term?.cols || 80,
            rows: state.term?.rows || 24,
          }));
        };

        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'ready') {
              clearTimeout(timeout);
              state.ws = ws;
              state.status = 'connected';
              if (msg.replay) {
                state.term?.write(msg.replay);
            }
            resolve();
          } else {
            this.applySessionMessage(state, msg);
          }
          } catch {}
        };

        ws.onerror = () => {
          clearTimeout(timeout);
          reject(new Error('Reconnect failed'));
        };
      });
    } catch (e) {
      state.status = 'error';
      throw e;
    }
  }

  /** List all active sessions. */
  listSessions(): TerminalOneSession[] {
    return Array.from(this.sessions.entries()).map(([id, state]) => ({
      id,
      title: state.cwd.split('/').pop() || 'terminal',
      cwd: state.cwd,
      status: state.status === 'connected' ? 'connected' : 'disconnected',
    }));
  }

  /** Register a session internally. */
  registerSession(sessionId: string, cwd: string): void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        ws: null,
        term: null,
        fit: null,
        search: null,
        sessionId,
        cwd,
        status: 'connecting',
        outputCallbacks: new Set(),
        exitCallbacks: new Set(),
        inputBuffer: '',
        inputFlushTimer: null,
        inputDataListener: null,
        resizeObserver: null,
        resizeElement: null,
        outputHandler: null,
      });
    }
  }

  /** Clean up all sessions. */
  dispose(): void {
    for (const [id] of this.sessions) {
      this.killSession(id);
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
  }
}
