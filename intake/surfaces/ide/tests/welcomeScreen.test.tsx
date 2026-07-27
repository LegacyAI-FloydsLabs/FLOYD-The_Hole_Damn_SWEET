import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { WelcomeScreen } from '@/components/WelcomeScreen';
import { HostProvider } from '@/platform/HostProvider';
import { MockHostGateway } from '@/platform/host';
import { WorkspaceProvider } from '@/workspace/WorkspaceProvider';

describe('welcome AI session preflight', () => {
  it('replaces repetitive branding with live context, Git, resume, and review signals', async () => {
    const gateway = new MockHostGateway({ workspaceRoot: '/projects/CURSEM-IDE' });
    Object.defineProperty(gateway, 'contextStatus', { value: vi.fn(async () => ({ root: '/projects/CURSEM-IDE', files: 412, bytes: 2 * 1024 * 1024, indexedAt: Date.now(), dirty: false, indexing: false })) });
    Object.defineProperty(gateway, 'gitStatus', { value: vi.fn(async () => ({ repoPath: '/projects/CURSEM-IDE', branch: 'feature/repair', upstream: null, ahead: 0, behind: 0, clean: false, prooflineGoverned: false, changedFiles: [{ path: 'a', status: 'modified', staged: false }, { path: 'b', status: 'added', staged: true }, { path: 'c', status: 'untracked', staged: false }], lastCommit: null })) });
    Object.defineProperty(gateway, 'agentListThreads', { value: vi.fn(async () => [{ id: 'thread-1', title: 'Repair provider routing', createdAt: 1, updatedAt: 2 }]) });
    Object.defineProperty(gateway, 'agentListCheckpoints', { value: vi.fn(async () => [{ id: 'checkpoint-1', runId: 'run-1', label: 'Provider fix', files: [], createdAt: 2 }]) });

    render(<HostProvider config={gateway.config} gateway={gateway}><WorkspaceProvider><WelcomeScreen /></WorkspaceProvider></HostProvider>);

    expect(screen.queryByText('LOCAL AI WORKBENCH')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'CURSEM IDE' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Know what the model will know' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('412 files')).toBeInTheDocument());
    expect(screen.getByText('2.0 MiB indexed')).toBeInTheDocument();
    expect(screen.getByText('3 changes')).toBeInTheDocument();
    expect(screen.getByText('Branch feature/repair')).toBeInTheDocument();
    expect(screen.getByText('Repair provider routing')).toBeInTheDocument();
    expect(screen.getByText('1 checkpoint')).toBeInTheDocument();
    expect(screen.getByText(/32 KiB retrieved repository context \+ 24 KiB selected conversation history/)).toBeInTheDocument();
  });
});
