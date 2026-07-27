import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { usePlatform } from '@/platform';
import { useUIStore } from '@/store/uiStore';
import { useWorkspace } from '@/workspace';
import { ThemeArtwork } from './ThemeArtwork';

interface SessionPreflight {
  contextFiles: number | null;
  contextBytes: number | null;
  contextIndexing: boolean;
  branch: string | null;
  changedFiles: number | null;
  lastThread: string | null;
  checkpoints: number | null;
}

const EMPTY_PREFLIGHT: SessionPreflight = {
  contextFiles: null,
  contextBytes: null,
  contextIndexing: false,
  branch: null,
  changedFiles: null,
  lastThread: null,
  checkpoints: null,
};

export function WelcomeScreen() {
  const { config, gateway } = usePlatform();
  const { workspaceRoot, openWorkspace, isOpeningWorkspace } = useWorkspace();
  const openPalette = useUIStore((state) => state.openPalette);
  const setPanel = useUIStore((state) => state.setPanel);
  const toggleTerminal = useUIStore((state) => state.toggleTerminal);
  const toggleAIChat = useUIStore((state) => state.toggleAIChat);
  const addToast = useUIStore((state) => state.addToast);
  const [preflight, setPreflight] = useState<SessionPreflight>(EMPTY_PREFLIGHT);

  useEffect(() => {
    let cancelled = false;
    if (!workspaceRoot) { setPreflight(EMPTY_PREFLIGHT); return () => { cancelled = true; }; }
    void Promise.allSettled([
      gateway.contextStatus(),
      gateway.gitStatus(workspaceRoot),
      gateway.agentListThreads(),
      gateway.agentListCheckpoints(),
    ]).then(([context, git, threads, checkpoints]) => {
      if (cancelled) return;
      setPreflight({
        contextFiles: context.status === 'fulfilled' ? context.value.files : null,
        contextBytes: context.status === 'fulfilled' ? context.value.bytes : null,
        contextIndexing: context.status === 'fulfilled' && context.value.indexing,
        branch: git.status === 'fulfilled' ? git.value.branch : null,
        changedFiles: git.status === 'fulfilled' ? git.value.changedFiles.length : null,
        lastThread: threads.status === 'fulfilled' ? threads.value[0]?.title || null : null,
        checkpoints: checkpoints.status === 'fulfilled' ? checkpoints.value.length : null,
      });
    });
    return () => { cancelled = true; };
  }, [gateway, workspaceRoot]);

  const exploreWorkspace = async () => {
    setPanel('explorer');
    if (workspaceRoot) return;
    try {
      const selected = await openWorkspace();
      if (selected) addToast(`Opened ${selected.project.name} as the workspace.`, 'success');
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Could not open the selected folder.', 'error');
    }
  };

  return (
    <div className="welcome-screen">
      <ThemeArtwork basePath={config.basePath} className="welcome-mark" />
      <section className="welcome-preflight" aria-label="AI session preflight">
        <p className="eyebrow">AI SESSION PREFLIGHT</p>
        <h1>Know what the model will know</h1>
        <p className="welcome-preflight-summary">Local context, token boundaries, and pending work before you send.</p>
        <div className="welcome-preflight-grid">
          <div><small>Search index</small><strong>{workspaceRoot ? preflight.contextFiles === null ? 'Checking…' : `${preflight.contextFiles.toLocaleString()} files` : 'No workspace'}</strong><span>{preflight.contextIndexing ? 'Indexing now' : preflight.contextBytes === null ? 'Open a folder to index' : formatBytes(preflight.contextBytes)}</span></div>
          <div><small>Working tree</small><strong>{preflight.changedFiles === null ? 'Checking…' : `${preflight.changedFiles} change${preflight.changedFiles === 1 ? '' : 's'}`}</strong><span>{preflight.branch ? `Branch ${preflight.branch}` : 'Git status unavailable'}</span></div>
          <button type="button" onClick={() => toggleAIChat()}><small>Resume</small><strong>{preflight.lastThread || 'Fresh conversation'}</strong><span>Open the coding partner</span></button>
          <button type="button" onClick={() => toggleAIChat()}><small>Review queue</small><strong>{preflight.checkpoints === null ? 'Checking…' : `${preflight.checkpoints} checkpoint${preflight.checkpoints === 1 ? '' : 's'}`}</strong><span>Inspect reversible AI edits</span></button>
        </div>
        <p className="welcome-token-boundary">Per request: up to 32 KiB retrieved repository context + 24 KiB selected conversation history.</p>
      </section>
      <div className="welcome-actions">
        <button className="welcome-action" onClick={() => void exploreWorkspace()} disabled={isOpeningWorkspace}><Icon name="folder-open" /><span><strong>{workspaceRoot ? 'Explore workspace' : 'Open workspace'}</strong><small>{workspaceRoot ? 'Browse real project files' : 'Choose a project folder'}</small></span></button>
        <button className="welcome-action" onClick={() => openPalette('files')}><Icon name="search" /><span><strong>Quick open</strong><small>Find a file by name</small></span><kbd>⌘P</kbd></button>
        <button className="welcome-action" onClick={() => toggleTerminal()}><Icon name="terminal" /><span><strong>Open TerminalOne</strong><small>Use the active local workspace</small></span><kbd>⌘J</kbd></button>
        <button className="welcome-action" onClick={() => toggleAIChat()}><Icon name="spark" /><span><strong>Open coding partner</strong><small>Route OpenCode, OpenAI, or Anthropic</small></span><kbd>⌘⇧A</kbd></button>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B indexed`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB indexed`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB indexed`;
}
