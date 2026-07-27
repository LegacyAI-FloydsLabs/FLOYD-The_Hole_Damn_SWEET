import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HostProvider } from '@/platform/HostProvider';
import { HttpHostGateway, MockHostGateway } from '@/platform/host';
import { WorkspaceProvider, useWorkspace } from '@/workspace/WorkspaceProvider';
import { FileTree } from '@/workspace/FileTree';
import { useEditorStore } from '@/store/editorStore';
import type { PlatformConfig } from '@/platform';

function WorkspaceProbe() {
  const { workspaceRoot, workspaceId, openWorkspace, isOpeningWorkspace } = useWorkspace();
  return (
    <div>
      <span data-testid="workspace-root">{workspaceRoot}</span>
      <span data-testid="workspace-id">{workspaceId}</span>
      <button onClick={() => void openWorkspace()} disabled={isOpeningWorkspace}>Choose workspace</button>
    </div>
  );
}

function renderWithWorkspace(gateway: MockHostGateway, child: React.ReactNode = <WorkspaceProbe />) {
  return render(
    <HostProvider config={gateway.config} gateway={gateway}>
      <WorkspaceProvider>{child}</WorkspaceProvider>
    </HostProvider>,
  );
}

describe('workspace folder selection', () => {
  beforeEach(() => {
    localStorage.clear();
    useEditorStore.getState().resetForWorkspace();
    vi.restoreAllMocks();
  });

  it('replaces the active root, clears old editor history, and emits workspace.changed', async () => {
    const gateway = new MockHostGateway({ workspaceId: 'old', workspaceRoot: '/projects/old' });
    gateway.setSelectedWorkspace('/projects/new', 'new');
    useEditorStore.getState().openTab('/projects/old/src/old.ts');

    renderWithWorkspace(gateway);
    fireEvent.click(screen.getByRole('button', { name: 'Choose workspace' }));

    await waitFor(() => expect(screen.getByTestId('workspace-root')).toHaveTextContent('/projects/new'));
    expect(screen.getByTestId('workspace-id')).toHaveTextContent('new');
    expect(useEditorStore.getState().tabs).toEqual([]);
    expect(useEditorStore.getState().recentlyClosed).toEqual([]);
    expect(gateway.eventBus.getHistory('workspace.changed')).toContainEqual({
      type: 'workspace.changed',
      workspaceId: 'new',
    });
  });

  it('does not switch roots when unsaved files are not approved', async () => {
    const gateway = new MockHostGateway({ workspaceId: 'old', workspaceRoot: '/projects/old' });
    gateway.setSelectedWorkspace('/projects/new', 'new');
    gateway.setConfirmResult(false);
    useEditorStore.getState().openTab('/projects/old/src/dirty.ts');
    useEditorStore.getState().markDirty('/projects/old/src/dirty.ts', true);

    renderWithWorkspace(gateway);
    fireEvent.click(screen.getByRole('button', { name: 'Choose workspace' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose workspace' })).not.toBeDisabled());
    expect(screen.getByTestId('workspace-root')).toHaveTextContent('/projects/old');
    expect(useEditorStore.getState().tabs).toHaveLength(1);
    expect(gateway.eventBus.getHistory('workspace.changed')).toEqual([]);
  });

  it('keeps editor state when the selected root is already active', async () => {
    const gateway = new MockHostGateway({ workspaceId: 'current', workspaceRoot: '/projects/current' });
    gateway.setSelectedWorkspace('/projects/current', 'current');
    useEditorStore.getState().openTab('/projects/current/src/open.ts');

    renderWithWorkspace(gateway);
    fireEvent.click(screen.getByRole('button', { name: 'Choose workspace' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose workspace' })).not.toBeDisabled());
    expect(useEditorStore.getState().tabs).toHaveLength(1);
    expect(gateway.eventBus.getHistory('workspace.changed')).toEqual([]);
  });

  it('opens a folder from the explorer and renders its directory tree', async () => {
    const gateway = new MockHostGateway({ workspaceId: '', workspaceRoot: '' });
    gateway.setSelectedWorkspace('/projects/floyd', 'floyd');
    gateway.setFile('/projects/floyd/src/index.ts', 'export const floyd = true;\n');

    renderWithWorkspace(gateway, <FileTree />);
    fireEvent.click(screen.getByRole('button', { name: 'Open folder as workspace' }));

    await waitFor(() => expect(screen.getByTitle('/projects/floyd')).toHaveTextContent('floyd'));
    expect(await screen.findByText('src')).toBeInTheDocument();
  });

  it('uses the trusted HTTP host folder-selection endpoint', async () => {
    const config: PlatformConfig = {
      workspaceId: '',
      workspaceRoot: '',
      gatewayUrl: 'http://floyd.test',
      opencodeUrl: '',
      basePath: '/ide/',
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      workspace: {
        id: 'selected',
        root: '/projects/selected',
        project: { id: 'selected', name: 'selected' },
        repositories: [],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const gateway = new HttpHostGateway(config);
    await expect(gateway.selectWorkspace()).resolves.toMatchObject({ root: '/projects/selected' });
    await expect(gateway.getWorkspace()).resolves.toMatchObject({ root: '/projects/selected' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://floyd.test/api/platform/workspace/select',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rejects malformed workspace data from the host', async () => {
    const gateway = new HttpHostGateway({
      workspaceId: '',
      workspaceRoot: '',
      gatewayUrl: 'http://floyd.test',
      opencodeUrl: '',
      basePath: '/ide/',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      workspace: { id: 'broken', root: '/projects/broken' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    await expect(gateway.selectWorkspace()).rejects.toThrow('invalid workspace selection');
  });
});
