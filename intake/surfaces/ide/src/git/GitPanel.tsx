// CURSE'M IDE — Git Panel (§7).
//
// Displays git status, changed files, staging area, commit interface,
// branch info, and history navigation.

import { useState, useEffect, useCallback } from 'react';
import { usePlatform } from '@/platform';
import { useWorkspace } from '@/workspace';
import { GitService } from './GitService';
import type { GitStatus } from '@/platform';
import { useUIStore } from '@/store/uiStore';

const STATUS_ICONS: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: 'C',
};

const STATUS_COLORS: Record<string, string> = {
  modified: 'var(--color-warning)',
  added: 'var(--color-success)',
  deleted: 'var(--color-error)',
  renamed: 'var(--color-accent)',
  untracked: 'var(--color-text-secondary)',
  conflicted: 'var(--color-error)',
};

export function GitPanel() {
  const { gateway } = usePlatform();
  const { workspaceRoot } = useWorkspace();
  const [service, setService] = useState<GitService | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const addToast = useUIStore((state) => state.addToast);

  useEffect(() => {
    setService(new GitService(gateway));
  }, [gateway]);

  const refresh = useCallback(async () => {
    if (!service) return;
    setLoading(true);
    try {
      const s = await service.status(workspaceRoot);
      setStatus(s);
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not refresh Git status.', 'error');
    }
    setLoading(false);
  }, [addToast, service, workspaceRoot]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleStageAll = async () => {
    if (!service || !status) return;
    const files = status.changedFiles.map((f) => f.path);
    if (files.length === 0) return;
    try {
      await service.stage(workspaceRoot, files);
      await refresh();
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Could not stage changes.', 'error');
    }
  };

  const handleCommit = async () => {
    if (!service || !commitMessage.trim() || status?.prooflineGoverned) return;
    try {
      await service.commit(workspaceRoot, commitMessage);
      setCommitMessage('');
      await refresh();
      addToast('Commit created.', 'success');
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Could not create commit.', 'error');
    }
  };

  const handlePush = async () => {
    if (!service || status?.prooflineGoverned) return;
    try {
      await service.push(workspaceRoot);
      addToast('Push completed.', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Git push failed.', 'error');
    }
  };

  const handlePull = async () => {
    if (!service) return;
    try {
      await service.pull(workspaceRoot);
      await refresh();
      addToast('Pull completed.', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Git pull failed.', 'error');
    }
  };

  if (!status) {
    return (
      <div className="git-panel">
        <div className="git-section-title">{loading ? 'Loading...' : 'Not a git repository'}</div>
      </div>
    );
  }

  return (
    <div className="git-panel">
      {/* Branch info */}
      <div className="git-section">
        <div className="git-section-title">
          Branch: {status.branch || 'none'}
          {status.upstream && ` tracking ${status.upstream}`}
          {status.ahead > 0 && ` · ${status.ahead} ahead`}
          {status.behind > 0 && ` · ${status.behind} behind`}
        </div>
        <div style={{ marginTop: 4 }}>
          <button className="debug-button" onClick={handlePull}>Pull</button>
          <button
            className="debug-button"
            onClick={handlePush}
            disabled={status.prooflineGoverned}
            title={status.prooflineGoverned ? 'Proofline governs publication for this repository.' : 'Push the current branch'}
          >
            Push
          </button>
          <button className="debug-button" onClick={refresh}>Refresh</button>
        </div>
      </div>

      {/* Changed files */}
      <div className="git-section">
        <div className="git-section-title">
          Changes ({status.changedFiles.length})
        </div>
        {status.changedFiles.length === 0 && status.clean && (
          <div style={{ padding: '4px 8px', color: 'var(--color-text-secondary)' }}>
            Working tree clean
          </div>
        )}
        {status.changedFiles.map((file) => (
          <div key={file.path} className="git-file-item">
            <span
              className="git-status-badge"
              style={{ color: STATUS_COLORS[file.status] || 'var(--color-text)' }}
            >
              {STATUS_ICONS[file.status] || '?'}
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {file.path.split('/').pop()}
            </span>
          </div>
        ))}
        {status.changedFiles.length > 0 && (
          <button className="debug-button" onClick={handleStageAll} style={{ marginTop: 4 }}>
            Stage All
          </button>
        )}
      </div>

      {/* Commit */}
      <div className="git-section">
        <div className="git-section-title">Commit</div>
        {status.prooflineGoverned && (
          <div className="panel-caption" role="note">
            Proofline governs commit and publication. Use its approved session-end flow after the required gates and authorization.
          </div>
        )}
        <textarea
          style={{
            width: '100%',
            minHeight: 60,
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text)',
            padding: 8,
            borderRadius: 4,
            fontSize: 13,
            resize: 'vertical',
          }}
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          placeholder={status.prooflineGoverned ? 'Commit through Proofline outside CURSEM' : 'Commit message...'}
          disabled={status.prooflineGoverned}
        />
        <button
          className="debug-button"
          onClick={handleCommit}
          disabled={!commitMessage.trim() || status.prooflineGoverned}
          style={{ marginTop: 4, opacity: commitMessage.trim() && !status.prooflineGoverned ? 1 : 0.5 }}
        >
          Commit
        </button>
      </div>

      {/* Last commit */}
      {status.lastCommit && (
        <div className="git-section">
          <div className="git-section-title">Last Commit</div>
          <div style={{ padding: '4px 8px', fontSize: 12 }}>
            <div style={{ color: 'var(--color-accent)' }}>{status.lastCommit.sha.slice(0, 7)}</div>
            <div>{status.lastCommit.subject}</div>
            <div style={{ color: 'var(--color-text-secondary)' }}>
              {status.lastCommit.author} · {status.lastCommit.date}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
