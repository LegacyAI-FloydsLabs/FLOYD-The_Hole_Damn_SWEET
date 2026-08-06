// CURSE'M IDE — in-shell CLI control executor (renderer half).
//
// Mounted once from CursemIDE. Connects the same-origin control WebSocket
// (/api/control/ws, subprotocol `cursem-control`); the backend validates the
// loopback same-origin upgrade and delivers the bearer token as the first
// frame — the ONLY way the token reaches the renderer (never via a GETable
// route, never persisted). The executor then answers forwarded control
// methods against the real stores and replies over the socket.
//
// TerminalPane reads getControlEnv() to inject CURSEM_API/CURSEM_TOKEN into
// newly spawned shells; SettingsDialog reads getControlToken() for the
// bearer-checked settings routes.

import { useEditorStore } from '@/store/editorStore';
import { useUIStore } from '@/store/uiStore';
import { getEditorAdapter } from '@/editor/types';
import {
  getTerminalSurfaceProvider,
  listSurfaces,
  resolveSurface,
  type SurfaceDescriptor,
  type TerminalSurfaceProvider,
} from './surfaceRegistry';

const CONTROL_SUBPROTOCOL = 'cursem-control';
const EDITOR_REVEAL_TIMEOUT_MS = 2_000;
const EDITOR_REVEAL_POLL_MS = 50;

let controlToken: string | null = null;
let controlApiBase: string | null = null;

/** The bearer token delivered over the control WS handshake (memory only). */
export function getControlToken(): string | null {
  return controlToken;
}

/** Env to inject into newly spawned shells, or null until the control
 *  channel has handshaken. */
export function getControlEnv(): Record<string, string> | null {
  if (!controlToken || !controlApiBase) return null;
  return { CURSEM_API: controlApiBase, CURSEM_TOKEN: controlToken };
}

class ControlError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Friendly key names → raw byte sequences (port of Cate's terminalDriver
 *  key map). Text insertion never implies execution: `type` sends no
 *  newline, only `press enter` does. */
export const KEY_BYTES: Record<string, string> = {
  enter: '\r',
  tab: '\t',
  esc: '\x1b',
  escape: '\x1b',
  backspace: '\x7f',
  delete: '\x1b[3~',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
};

function keyBytes(key: string): string {
  const normalized = String(key).toLowerCase();
  if (KEY_BYTES[normalized]) return KEY_BYTES[normalized];
  const chord = normalized.match(/^ctrl-([a-z])$/);
  if (chord) return String.fromCharCode(chord[1].charCodeAt(0) - 96);
  throw new ControlError('bad-key', `Unknown key "${key}". Use enter, tab, esc, backspace, delete, arrows, home, end, pageup, pagedown, or ctrl-<letter>.`);
}

function requireProvider(): TerminalSurfaceProvider {
  const provider = getTerminalSurfaceProvider();
  if (!provider) throw new ControlError('no-terminals', 'No terminal session exists yet — open the terminal panel once.');
  return provider;
}

function resolveTerminalSessionId(args: Record<string, unknown>, { requireExplicit }: { requireExplicit: boolean }): string {
  const provider = requireProvider();
  const targetId = typeof args.targetId === 'string' ? args.targetId : '';
  if (!targetId) {
    if (requireExplicit) throw new ControlError('target-required', 'This verb requires an explicit --panel target.');
    const activeId = provider.activeId();
    if (!activeId) throw new ControlError('no-focused-terminal', 'No terminal is focused; pass --panel <id>.');
    return activeId;
  }
  const resolved = resolveSurface(targetId, 'terminal');
  if (!resolved.ok) throw new ControlError(resolved.code, resolved.message);
  return resolved.surface.sessionId as string;
}

function resolveAnySurface(args: Record<string, unknown>): SurfaceDescriptor {
  const targetId = typeof args.targetId === 'string' ? args.targetId : '';
  if (!targetId) throw new ControlError('target-required', 'This verb requires a surface id.');
  const resolved = resolveSurface(targetId);
  if (!resolved.ok) throw new ControlError(resolved.code, resolved.message);
  return resolved.surface;
}

/** Wait until the editor has the path active (openTab → async file load),
 *  then reveal. Best-effort: document tabs and slow loads skip silently. */
async function revealWhenReady(path: string, line: number, column: number): Promise<void> {
  const deadline = Date.now() + EDITOR_REVEAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const adapter = getEditorAdapter();
    if (adapter && adapter.getActiveFile() === path) {
      adapter.revealPosition(path, line, column);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, EDITOR_REVEAL_POLL_MS));
  }
}

async function execute(method: string, args: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'cursem.terminal.read': {
      const provider = requireProvider();
      const sessionId = resolveTerminalSessionId(args, { requireExplicit: false });
      const text = provider.readScreen(sessionId);
      if (text === null) throw new ControlError('no-such', `Terminal session is not readable: ${sessionId}`);
      return { text };
    }
    case 'cursem.terminal.type': {
      const provider = requireProvider();
      const sessionId = resolveTerminalSessionId(args, { requireExplicit: true });
      const text = typeof args.text === 'string' ? args.text : '';
      if (!text) throw new ControlError('bad-request', 'terminal.type requires text.');
      provider.sendInput(sessionId, text);
      return { ok: true };
    }
    case 'cursem.terminal.press': {
      const provider = requireProvider();
      const sessionId = resolveTerminalSessionId(args, { requireExplicit: true });
      provider.sendInput(sessionId, keyBytes(String(args.key ?? '')));
      return { ok: true };
    }
    case 'cursem.editor.openFile': {
      const path = typeof args.path === 'string' ? args.path : '';
      if (!path) throw new ControlError('bad-request', 'editor.openFile requires a path.');
      useEditorStore.getState().openTab(path);
      const line = typeof args.line === 'number' ? args.line : undefined;
      if (line !== undefined) {
        const column = typeof args.column === 'number' ? args.column : 1;
        await revealWhenReady(path, line, column);
      }
      return { id: `editor:${path}` };
    }
    case 'cursem.surface.list':
      return { surfaces: listSurfaces() };
    case 'cursem.surface.focus': {
      const surface = resolveAnySurface(args);
      if (surface.type === 'editor') {
        useEditorStore.getState().setActiveTab(surface.path as string);
      } else {
        requireProvider().focus(surface.sessionId as string);
      }
      return { ok: true };
    }
    case 'cursem.surface.close': {
      const surface = resolveAnySurface(args);
      if (surface.type === 'editor') {
        useEditorStore.getState().closeTab(surface.path as string);
      } else {
        requireProvider().close(surface.sessionId as string);
      }
      return { ok: true };
    }
    case 'cursem.surface.setTitle': {
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      if (!title) throw new ControlError('bad-request', 'surface.setTitle requires a title.');
      const surface = resolveAnySurface(args);
      if (surface.type !== 'terminal') {
        throw new ControlError('unsupported', 'Only terminal surfaces can be retitled (editor tab titles follow the file path).');
      }
      requireProvider().rename(surface.sessionId as string, title);
      return { ok: true };
    }
    case 'cursem.ui.notify': {
      const message = typeof args.message === 'string' ? args.message : '';
      if (!message) throw new ControlError('bad-request', 'ui.notify requires a message.');
      // Toast is the guaranteed channel; desktop Notification degrades on
      // permission denial (browser-hosted replacement for Electron's API).
      useUIStore.getState().addToast(message, 'info');
      try {
        if (typeof Notification !== 'undefined') {
          if (Notification.permission === 'granted') new Notification('CURSEM IDE', { body: message });
          else if (Notification.permission === 'default') {
            void Notification.requestPermission().then((permission) => {
              if (permission === 'granted') new Notification('CURSEM IDE', { body: message });
            });
          }
        }
      } catch { /* notifications unavailable — toast already posted */ }
      return { ok: true };
    }
    default:
      throw new ControlError('unsupported', `Unsupported control method: ${method}`);
  }
}

interface ControlRequestMessage {
  type?: string;
  token?: string;
  api?: string;
  requestId?: number;
  method?: string;
  args?: Record<string, unknown>;
}

/**
 * Connect the control channel and answer forwarded methods until the returned
 * unmount function runs. Reconnects with bounded backoff — a missing backend
 * (vite dev UI, pre-build) degrades to "CLI env not injected" only.
 */
export function mountControlExecutor(): () => void {
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: number | null = null;
  let retries = 0;

  const schedule = () => {
    if (stopped) return;
    retries += 1;
    retryTimer = window.setTimeout(connect, Math.min(1_000 * retries, 5_000));
  };

  const connect = () => {
    if (stopped) return;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${window.location.host}/api/control/ws`, [CONTROL_SUBPROTOCOL]);
    socket = ws;

    ws.onopen = () => { retries = 0; };
    ws.onmessage = (event) => {
      let msg: ControlRequestMessage;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg?.type === 'hello' && typeof msg.token === 'string') {
        controlToken = msg.token;
        controlApiBase = typeof msg.api === 'string' ? msg.api : null;
        return;
      }
      if (typeof msg?.requestId !== 'number' || typeof msg.method !== 'string') return;
      const requestId = msg.requestId;
      void execute(msg.method, msg.args ?? {})
        .then((result) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ requestId, ok: true, result: result ?? null }));
        })
        .catch((error) => {
          const code = error instanceof ControlError ? error.code : 'executor-error';
          const message = error instanceof Error ? error.message : 'The control executor failed.';
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ requestId, ok: false, error: { code, message } }));
        });
    };
    ws.onerror = () => { ws.close(); };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      controlToken = null;
      controlApiBase = null;
      schedule();
    };
  };

  connect();

  return () => {
    stopped = true;
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    socket?.close();
    controlToken = null;
    controlApiBase = null;
  };
}
