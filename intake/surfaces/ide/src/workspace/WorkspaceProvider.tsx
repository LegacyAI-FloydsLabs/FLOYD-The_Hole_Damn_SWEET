// CURSE'M IDE — Workspace Provider (§2).
//
// React context that provides the FileSystemService to all components.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { FileSystemService } from './FileSystemService';
import { usePlatform } from '@/platform';
import type { Workspace } from '@/platform';
import { useEditorStore } from '@/store/editorStore';

export interface WorkspaceContextValue {
  fs: FileSystemService;
  workspaceRoot: string;
  workspaceId: string;
  isOpeningWorkspace: boolean;
  openWorkspace: () => Promise<Workspace | null>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export interface WorkspaceProviderProps {
  children: React.ReactNode;
}

export function WorkspaceProvider({ children }: WorkspaceProviderProps) {
  const { gateway, config } = usePlatform();
  const [workspace, setWorkspace] = useState<Workspace | null>(() => config.workspaceRoot ? {
    id: config.workspaceId,
    root: config.workspaceRoot,
    project: {
      id: config.workspaceId,
      name: config.workspaceRoot.split('/').filter(Boolean).pop() || 'workspace',
    },
    repositories: [],
  } : null);
  const [isOpeningWorkspace, setIsOpeningWorkspace] = useState(false);
  const selectionInFlight = useRef(false);

  const workspaceRoot = workspace?.root ?? '';
  const workspaceId = workspace?.id ?? '';

  useEffect(() => {
    setWorkspace(config.workspaceRoot ? {
      id: config.workspaceId,
      root: config.workspaceRoot,
      project: {
        id: config.workspaceId,
        name: config.workspaceRoot.split('/').filter(Boolean).pop() || 'workspace',
      },
      repositories: [],
    } : null);
  }, [config.workspaceId, config.workspaceRoot]);

  const openWorkspace = useCallback(async (): Promise<Workspace | null> => {
    if (selectionInFlight.current) return null;
    if (!gateway.selectWorkspace) {
      throw new Error('This CURSEM host does not support folder selection yet.');
    }

    const dirtyTabs = useEditorStore.getState().tabs.filter((tab) => tab.isDirty);
    if (dirtyTabs.length > 0) {
      const confirmed = await gateway.confirmDestructive(
        'switch workspace with unsaved files',
        dirtyTabs.map((tab) => tab.path).join('\n'),
      );
      if (!confirmed) return null;
    }

    selectionInFlight.current = true;
    setIsOpeningWorkspace(true);
    try {
      const selected = await gateway.selectWorkspace();
      if (!selected) return null;
      if (!selected.root.trim()) throw new Error('The selected workspace has no filesystem root.');
      if (selected.root === workspaceRoot) return null;

      useEditorStore.getState().resetForWorkspace();
      setWorkspace(selected);
      gateway.emit({ type: 'workspace.changed', workspaceId: selected.id });
      return selected;
    } finally {
      selectionInFlight.current = false;
      setIsOpeningWorkspace(false);
    }
  }, [gateway, workspaceRoot]);

  const fs = useMemo(() => new FileSystemService(gateway, workspaceRoot), [gateway, workspaceRoot]);
  const value = useMemo<WorkspaceContextValue>(() => {
    return {
      fs,
      workspaceRoot,
      workspaceId,
      isOpeningWorkspace,
      openWorkspace,
    };
  }, [fs, isOpeningWorkspace, openWorkspace, workspaceId, workspaceRoot]);

  // §2: "Support filesystem watching and externally changed files."
  useEffect(() => {
    if (!workspaceRoot) return;
    fs.startWatching();
    return () => { fs.stopWatching(); };
  }, [fs, workspaceRoot]);

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return ctx;
}
