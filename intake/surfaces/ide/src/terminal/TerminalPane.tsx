import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { usePlatform, type TerminalOneSession } from '@/platform';
import { useWorkspace } from '@/workspace';
import { TerminalOneAdapter } from './TerminalOneAdapter';
import { useUIStore } from '@/store/uiStore';
import { toTerminalTheme } from '@/theme';
import { fontStack } from '@/font';

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
  const [sessions, setSessions] = useState<TerminalOneSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
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

  const createTerminal = useCallback(async () => {
    const adapter = adapterRef.current;
    if (!adapter || !workspaceRoot) {
      setStatus('disconnected');
      return;
    }
    setStatus('connecting');
    try {
      const session = await adapter.createSession(workspaceRoot, 80, 24);
      setSessions((current) => [...current, { ...session, title: `terminal ${current.length + 1}` }]);
      setStatus('connected');
      requestAnimationFrame(() => attach(session.id));
    } catch (error) {
      setStatus('disconnected');
      addToast(error instanceof Error ? error.message : 'TerminalOne connection failed.', 'error');
    }
  }, [addToast, attach, workspaceRoot]);

  useEffect(() => {
    const preferences = useUIStore.getState().preferences;
    const adapter = new TerminalOneAdapter(gateway, toTerminalTheme(preferences.theme), fontStack(preferences.fontFamily));
    adapterRef.current = adapter;
    void createTerminal();
    return () => { adapter.dispose(); adapterRef.current = null; };
  }, [createTerminal, gateway]);

  useEffect(() => {
    adapterRef.current?.setRendererTheme(toTerminalTheme(themeId));
  }, [themeId]);

  useEffect(() => {
    adapterRef.current?.setRendererFontFamily(fontStack(fontFamily));
  }, [fontFamily]);

  const closeSession = (sessionId: string) => {
    adapterRef.current?.killSession(sessionId);
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
            <button key={session.id} className={`panel-tab ${session.id === activeId ? 'active' : ''}`} onClick={() => attach(session.id)} role="tab" aria-selected={session.id === activeId}>
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
