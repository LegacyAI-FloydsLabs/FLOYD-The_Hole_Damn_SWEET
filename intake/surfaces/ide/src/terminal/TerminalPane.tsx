import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { usePlatform, type TerminalOneSession } from '@/platform';
import { useWorkspace } from '@/workspace';
import { TerminalOneAdapter } from './TerminalOneAdapter';
import { useUIStore } from '@/store/uiStore';
import { toTerminalTheme } from '@/theme';
import { fontStack } from '@/font';
import { registerTerminalSurfaceProvider } from '@/platform/surfaceRegistry';
import { getControlEnv } from '@/platform/controlExecutor';

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

type TerminalPaneRuntime = {
  adapter: TerminalOneAdapter | null;
  sessions: TerminalOneSession[];
  activeId: string | null;
  status: ConnectionStatus;
  workspaceRoot: string | null;
};

const terminalPaneRuntime: TerminalPaneRuntime = {
  adapter: null,
  sessions: [],
  activeId: null,
  status: 'connecting',
  workspaceRoot: null,
};

/** Custom event the control executor uses to reach the mounted pane. The
 *  runtime object above is mutated synchronously (so CLI results reflect
 *  reality immediately); the event lets the React layer catch up. */
const TERMINAL_COMMAND_EVENT = 'cursem:terminal-command';

export type TerminalCommand =
  | { type: 'focus'; id: string }
  | { type: 'close'; id: string }
  | { type: 'rename'; id: string; title: string };

function dispatchTerminalCommand(command: TerminalCommand): void {
  window.dispatchEvent(new CustomEvent<TerminalCommand>(TERMINAL_COMMAND_EVENT, { detail: command }));
}

// Register the terminal half of the unified surface registry at module load
// (not on component mount): the adapter and session list live in the module-
// level runtime, so CLI surface verbs keep working while the terminal panel
// is hidden. This indirection also keeps controlExecutor free of a static
// import of this lazily-loaded module.
registerTerminalSurfaceProvider({
  list: () => terminalPaneRuntime.sessions.map((session) => ({ id: session.id, title: session.title })),
  activeId: () => terminalPaneRuntime.activeId,
  focus: (sessionId) => {
    if (!terminalPaneRuntime.sessions.some((session) => session.id === sessionId)) return;
    terminalPaneRuntime.activeId = sessionId;
    // Reveal the panel if hidden — the mount effect opens runtime.activeId.
    const ui = useUIStore.getState();
    if (!ui.terminalVisible) ui.toggleTerminal();
    dispatchTerminalCommand({ type: 'focus', id: sessionId });
  },
  close: (sessionId) => {
    terminalPaneRuntime.adapter?.killSession(sessionId);
    const next = terminalPaneRuntime.sessions.filter((session) => session.id !== sessionId);
    terminalPaneRuntime.sessions = next;
    if (terminalPaneRuntime.activeId === sessionId) {
      terminalPaneRuntime.activeId = next.at(-1)?.id ?? null;
    }
    dispatchTerminalCommand({ type: 'close', id: sessionId });
  },
  rename: (sessionId, title) => {
    terminalPaneRuntime.sessions = terminalPaneRuntime.sessions.map((session) =>
      session.id === sessionId ? { ...session, title } : session);
    dispatchTerminalCommand({ type: 'rename', id: sessionId, title });
  },
  sendInput: (sessionId, data) => terminalPaneRuntime.adapter?.sendInput(sessionId, data),
  readScreen: (sessionId) => terminalPaneRuntime.adapter?.readScreen(sessionId) ?? null,
});

export function TerminalPane() {
  const containerRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<TerminalOneAdapter | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const { gateway } = usePlatform();
  const { workspaceRoot } = useWorkspace();
  const toggleTerminal = useUIStore((state) => state.toggleTerminal);
  const addToast = useUIStore((state) => state.addToast);
  const themeId = useUIStore((state) => state.preferences.theme);
  const fontFamily = useUIStore((state) => state.preferences.fontFamily);
  const [sessions, setSessions] = useState<TerminalOneSession[]>(terminalPaneRuntime.sessions);
  const [activeId, setActiveId] = useState<string | null>(terminalPaneRuntime.activeId);
  const [status, setStatus] = useState<ConnectionStatus>(terminalPaneRuntime.status);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const attach = useCallback((sessionId: string) => {
    const adapter = adapterRef.current;
    const container = containerRef.current;
    if (!adapter || !container) return;
    if (activeIdRef.current && activeIdRef.current !== sessionId) adapter.detachRenderer(activeIdRef.current);
    container.replaceChildren();
    adapter.attachRenderer(sessionId, container);
    activeIdRef.current = sessionId;
    setActiveId(sessionId);
  }, []);

  const openSession = useCallback(async (sessionId: string) => {
    const adapter = adapterRef.current;
    if (!adapter) return;
    const session = terminalPaneRuntime.sessions.find((item) => item.id === sessionId);
    if (!session) return;

    if (session.attached === false && session.resumable) {
      setStatus('connecting');
      try {
        await adapter.resumeSession(sessionId, 80, 24);
      } catch (error) {
        setStatus('disconnected');
        addToast(error instanceof Error ? error.message : 'Terminal resume failed.', 'error');
        return;
      }
    }

    requestAnimationFrame(() => attach(sessionId));
    setStatus('connected');
  }, [addToast, attach]);

  const createTerminal = useCallback(async () => {
    const adapter = adapterRef.current;
    if (!adapter || !workspaceRoot) {
      setStatus('disconnected');
      return;
    }
    setStatus('connecting');
    try {
      // Inject the in-shell CLI channel (CURSEM_API/CURSEM_TOKEN) when the
      // control executor has handshaken; TerminalOne stamps CURSEM_TERMINAL_ID
      // and the CLI bin PATH itself.
      const session = await adapter.createSession(workspaceRoot, 80, 24, getControlEnv() ?? undefined);
      const nextSessions = [...terminalPaneRuntime.sessions, { ...session, title: `terminal ${terminalPaneRuntime.sessions.length + 1}` }];
      terminalPaneRuntime.sessions = nextSessions;
      setSessions(nextSessions);
      setActiveId(session.id);
      terminalPaneRuntime.activeId = session.id;
      terminalPaneRuntime.status = 'connected';
      setStatus('connected');
      requestAnimationFrame(() => attach(session.id));
    } catch (error) {
      setStatus('disconnected');
      addToast(error instanceof Error ? error.message : 'TerminalOne connection failed.', 'error');
    }
  }, [addToast, attach, workspaceRoot]);

  const refreshRuntimeSessions = useCallback(async (workspace: string) => {
    const adapter = adapterRef.current;
    if (!adapter) return;

    let recovered = await adapter.discoverSessions(workspace);
    if (recovered.length === 0) {
      recovered = adapter.listSessions();
    }

    terminalPaneRuntime.sessions = recovered;
    setSessions(recovered);
    setStatus(recovered.some((session) => session.attached) ? 'connected' : 'disconnected');

    const nextActiveId = terminalPaneRuntime.sessions.find((session) => session.id === terminalPaneRuntime.activeId)?.id
      ?? terminalPaneRuntime.sessions.at(-1)?.id
      ?? null;
    terminalPaneRuntime.activeId = nextActiveId;
    setActiveId(nextActiveId);

    if (nextActiveId) {
      await openSession(nextActiveId);
    } else {
      await createTerminal();
    }
  }, [createTerminal, openSession]);

  const clearRuntimeSessions = useCallback(() => {
    if (terminalPaneRuntime.adapter) {
      for (const session of terminalPaneRuntime.sessions) {
        terminalPaneRuntime.adapter.killSession(session.id);
      }
    }
    terminalPaneRuntime.sessions = [];
    terminalPaneRuntime.activeId = null;
    setSessions([]);
    setActiveId(null);
    setStatus('disconnected');
    terminalPaneRuntime.status = 'disconnected';
    activeIdRef.current = null;
    if (containerRef.current) {
      containerRef.current.replaceChildren();
    }
  }, []);

  useEffect(() => {
    const preferences = useUIStore.getState().preferences;
    if (!terminalPaneRuntime.adapter) {
      terminalPaneRuntime.adapter = new TerminalOneAdapter(
        gateway,
        toTerminalTheme(preferences.theme),
        fontStack(preferences.fontFamily),
      );
    }
    const adapter = terminalPaneRuntime.adapter;
    adapterRef.current = adapter;
    if (!workspaceRoot) {
      setStatus('disconnected');
      terminalPaneRuntime.status = 'disconnected';
      if (activeIdRef.current) {
        adapter.detachRenderer(activeIdRef.current);
      }
      adapterRef.current = null;
      return () => {
        adapterRef.current = null;
      };
    }
    if (terminalPaneRuntime.workspaceRoot && terminalPaneRuntime.workspaceRoot !== workspaceRoot) {
      clearRuntimeSessions();
    }
    terminalPaneRuntime.workspaceRoot = workspaceRoot;

    (async () => {
      try {
        await refreshRuntimeSessions(workspaceRoot);
      } catch {
        // Fallback to legacy in-memory sessions when admin endpoint is unavailable.
        const recoveredSessions = adapter.listSessions();
        terminalPaneRuntime.sessions = recoveredSessions;
        setSessions(recoveredSessions);
        setStatus(recoveredSessions.length > 0 ? 'connected' : 'disconnected');
        const currentActiveId = terminalPaneRuntime.activeId;
        const nextActiveId = recoveredSessions.find((session) => session.id === currentActiveId)?.id ?? recoveredSessions.at(-1)?.id ?? null;
        terminalPaneRuntime.activeId = nextActiveId;
        setActiveId(nextActiveId);
        if (nextActiveId) {
          void openSession(nextActiveId);
        } else {
          void createTerminal();
        }
      }
    })();

    return () => {
      if (activeIdRef.current) {
        adapter.detachRenderer(activeIdRef.current);
      }
      adapterRef.current = null;
    };
  },
    [clearRuntimeSessions, createTerminal, openSession, refreshRuntimeSessions, gateway, workspaceRoot],
  );

  useEffect(() => {
    adapterRef.current?.setRendererTheme(toTerminalTheme(themeId));
  }, [themeId]);

  useEffect(() => {
    adapterRef.current?.setRendererFontFamily(fontStack(fontFamily));
  }, [fontFamily]);

  useEffect(() => {
    terminalPaneRuntime.sessions = sessions;
    terminalPaneRuntime.status = status;
    terminalPaneRuntime.activeId = activeId;
    terminalPaneRuntime.workspaceRoot = workspaceRoot;
  }, [sessions, status, activeId, workspaceRoot]);

  const closeSession = (sessionId: string) => {
    adapterRef.current?.killSession(sessionId);
    terminalPaneRuntime.sessions = terminalPaneRuntime.sessions.filter((session) => session.id !== sessionId);
    setSessions((current) => {
      const next = current.filter((session) => session.id !== sessionId);
      if (activeId === sessionId) {
        const replacement = next.at(-1);
        activeIdRef.current = replacement?.id ?? null;
        setActiveId(replacement?.id ?? null);
        if (replacement) requestAnimationFrame(() => attach(replacement.id));
      }
      return next;
    });
  };

  // Catch up with control-executor surface commands (focus/close/rename) —
  // the provider has already mutated terminalPaneRuntime; sync React state.
  useEffect(() => {
    const onCommand = (event: Event) => {
      const command = (event as CustomEvent<TerminalCommand>).detail;
      if (!command) return;
      if (command.type === 'focus') {
        if (terminalPaneRuntime.sessions.some((session) => session.id === command.id)) {
          void openSession(command.id);
        }
        return;
      }
      if (command.type === 'close') {
        const next = terminalPaneRuntime.sessions;
        setSessions(next);
        if (activeIdRef.current === command.id) {
          const replacement = next.at(-1)?.id ?? null;
          activeIdRef.current = replacement;
          setActiveId(replacement);
          if (replacement) requestAnimationFrame(() => attach(replacement));
        }
        return;
      }
      setSessions([...terminalPaneRuntime.sessions]);
    };
    window.addEventListener(TERMINAL_COMMAND_EVENT, onCommand);
    return () => window.removeEventListener(TERMINAL_COMMAND_EVENT, onCommand);
  }, [attach, openSession]);

  const reconnect = async () => {
    if (!activeId || !adapterRef.current) return;
    setStatus('connecting');
    try {
      await adapterRef.current.reconnect(activeId);
      setStatus('connected');
      attach(activeId);
    } catch (error) {
      setStatus('disconnected');
      addToast(error instanceof Error ? error.message : 'Terminal reconnect failed.', 'error');
    }
  };

  return (
    <section className="terminal-pane" aria-label="TerminalOne">
      <header className="terminal-header">
      <div className="panel-tabs" role="tablist" aria-label="Terminal sessions">
        {sessions.map((session) => (
            <button key={session.id} className={`panel-tab ${session.id === activeId ? 'active' : ''}`} onClick={() => void openSession(session.id)} role="tab" aria-selected={session.id === activeId}>
              <span>{session.title}</span><span className="session-status" data-status={session.status} />
              <span className="panel-tab-close" role="button" aria-label={`Close ${session.title}`} onClick={(event) => { event.stopPropagation(); closeSession(session.id); }}><Icon name="close" size={12} /></span>
            </button>
          ))}
        </div>
        <div className="terminal-actions">
          <span className={`connection-label ${status}`}>{status}</span>
          <button className="icon-button compact" onClick={() => setSearchOpen((open) => !open)} title="Search terminal" aria-label="Search terminal"><Icon name="search" size={15} /></button>
          <button className="icon-button compact" onClick={() => void createTerminal()} title="New terminal" aria-label="New terminal"><Icon name="plus" size={15} /></button>
          {status === 'disconnected' && <button className="text-button" onClick={() => void reconnect()}>Reconnect</button>}
          <button className="icon-button compact" onClick={toggleTerminal} title="Close terminal panel" aria-label="Close terminal panel"><Icon name="close" size={15} /></button>
        </div>
      </header>
      {searchOpen && <form className="terminal-search" onSubmit={(event) => { event.preventDefault(); if (activeId) adapterRef.current?.search(activeId, searchQuery); }}><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Find in terminal" autoFocus /><button className="button secondary compact-button">Find</button></form>}
      <div className="terminal-body" ref={containerRef} />
      {sessions.length === 0 && status === 'disconnected' && <div className="terminal-empty"><Icon name="terminal" /><strong>TerminalOne is unavailable</strong><span>Restart CURSEM IDE to restore its authenticated local terminal service.</span></div>}
    </section>
  );
}
