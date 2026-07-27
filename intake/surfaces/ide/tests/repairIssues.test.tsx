import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DebugPanel } from '@/debug/DebugPanel';
import { GitPanel } from '@/git/GitPanel';
import { HostProvider } from '@/platform/HostProvider';
import { MockHostGateway } from '@/platform/host';
import { WorkspaceProvider } from '@/workspace/WorkspaceProvider';

function renderWorkbenchPanel(panel: React.ReactNode, gateway: MockHostGateway) {
  return render(
    <HostProvider config={gateway.config} gateway={gateway}>
      <WorkspaceProvider>{panel}</WorkspaceProvider>
    </HostProvider>,
  );
}

describe('dogfood issue regressions', () => {
  it('disables raw commit and push controls for a Proofline-governed repository', async () => {
    const gateway = new MockHostGateway({ workspaceRoot: '/test/workspace' });
    Object.defineProperty(gateway, 'gitStatus', {
      value: vi.fn(async () => ({
        repoPath: '/test/workspace',
        branch: 'main',
        upstream: 'origin/main',
        ahead: 0,
        behind: 0,
        clean: false,
        prooflineGoverned: true,
        changedFiles: [{ path: 'src/main.ts', status: 'modified' as const, staged: true }],
        lastCommit: null,
      })),
    });

    renderWorkbenchPanel(<GitPanel />, gateway);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Push' })).toBeDisabled());
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
    expect(screen.getByRole('note')).toHaveTextContent('Proofline governs commit and publication');
    expect(screen.getByRole('button', { name: 'Pull' })).toBeEnabled();
  });

  it('gives each task Run action a distinct accessible name', async () => {
    const gateway = new MockHostGateway({ workspaceRoot: '/test/workspace' });
    Object.defineProperty(gateway, 'taskList', {
      value: vi.fn(async () => [
        { id: 'package:build', label: 'build', executable: 'npm', args: ['run', 'build'], kind: 'task' as const, source: 'package.json' },
        { id: 'package:test', label: 'test', executable: 'npm', args: ['run', 'test'], kind: 'test' as const, source: 'package.json' },
      ]),
    });

    renderWorkbenchPanel(<DebugPanel />, gateway);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Run build' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Run test' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
  });
});
