import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Icon } from '@/components/Icon';
import { useWorkspace } from './WorkspaceProvider';
import { useEditorStore } from '@/store/editorStore';
import { useUIStore } from '@/store/uiStore';
import { usePlatform } from '@/platform';
import type { DirEntry } from '@/platform';

interface TreeNode {
  entry: DirEntry;
  children: TreeNode[] | null;
  loading: boolean;
}

function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'dir' ? -1 : 1;
  });
}

function updateNode(nodes: TreeNode[], path: string, update: (node: TreeNode) => TreeNode): TreeNode[] {
  return nodes.map((node) => {
    if (node.entry.path === path) return update(node);
    if (!node.children) return node;
    return { ...node, children: updateNode(node.children, path, update) };
  });
}

export function FileTree() {
  const { fs, workspaceRoot, openWorkspace, isOpeningWorkspace } = useWorkspace();
  const { gateway } = usePlatform();
  const openTab = useEditorStore((state) => state.openTab);
  const activeTabPath = useEditorStore((state) => state.activeTabPath);
  const addToast = useUIStore((state) => state.addToast);
  const inputRef = useRef<HTMLInputElement>(null);
  const [rootNodes, setRootNodes] = useState<TreeNode[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const loadRoot = useCallback(async () => {
    if (!workspaceRoot) {
      setRootNodes([]);
      setState('ready');
      return;
    }
    setState('loading');
    try {
      const entries = sortEntries(await fs.listDir(workspaceRoot));
      setRootNodes(entries.map((entry) => ({ entry, children: null, loading: false })));
      setState('ready');
    } catch (error) {
      setState('error');
      addToast(error instanceof Error ? error.message : 'Could not load the workspace.', 'error');
    }
  }, [addToast, fs, workspaceRoot]);

  useEffect(() => { void loadRoot(); }, [loadRoot]);

  const chooseWorkspace = async () => {
    try {
      const selected = await openWorkspace();
      if (selected) addToast(`Opened ${selected.project.name} as the workspace.`, 'success');
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Could not open the selected folder.', 'error');
    }
  };

  const toggleDirectory = async (node: TreeNode) => {
    if (node.children !== null) {
      setRootNodes((nodes) => updateNode(nodes, node.entry.path, (current) => ({ ...current, children: null })));
      return;
    }
    setRootNodes((nodes) => updateNode(nodes, node.entry.path, (current) => ({ ...current, loading: true })));
    try {
      const entries = sortEntries(await fs.listDir(node.entry.path));
      const children = entries.map((entry) => ({ entry, children: null, loading: false }));
      setRootNodes((nodes) => updateNode(nodes, node.entry.path, (current) => ({ ...current, children, loading: false })));
    } catch (error) {
      setRootNodes((nodes) => updateNode(nodes, node.entry.path, (current) => ({ ...current, loading: false })));
      addToast(error instanceof Error ? error.message : `Could not open ${node.entry.name}.`, 'error');
    }
  };

  const importFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (!workspaceRoot || files.length === 0) return;
    let imported = 0;
    for (const file of files) {
      try {
        const content = await file.text();
        const path = `${workspaceRoot.replace(/\/$/, '')}/${file.name}`;
        try {
          await fs.stat(path);
          const confirmed = await gateway.confirmDestructive('replace imported file', path);
          if (!confirmed) continue;
        } catch {
          // A missing destination is the expected case for a new import.
        }
        await fs.writeFile(path, content);
        openTab(path);
        imported++;
      } catch (error) {
        addToast(error instanceof Error ? error.message : `Could not import ${file.name}.`, 'error');
      }
    }
    event.target.value = '';
    await loadRoot();
    if (imported > 0) addToast(`Imported ${imported} file${imported === 1 ? '' : 's'} into the workspace.`, 'success');
  };

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const expanded = node.children !== null;
    return (
      <div key={node.entry.path}>
        <button
          className={`file-tree-item ${node.entry.type} ${activeTabPath === node.entry.path ? 'active' : ''}`}
          style={{ paddingLeft: `${depth * 14 + 9}px` }}
          onClick={() => node.entry.type === 'dir' ? void toggleDirectory(node) : openTab(node.entry.path)}
          aria-expanded={node.entry.type === 'dir' ? expanded : undefined}
          title={node.entry.path}
        >
          <span className="file-tree-icon">
            {node.entry.type === 'dir' ? <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={13} /> : <span className="file-dot" />}
          </span>
          <span className="file-tree-name">{node.entry.name}</span>
          {node.loading && <span className="loading-label">loading</span>}
        </button>
        {node.children?.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <section className="file-tree" aria-label="Workspace explorer">
      <header className="panel-title-row">
        <span>EXPLORER</span>
        <div className="panel-actions">
          <button className="icon-button compact" onClick={() => void chooseWorkspace()} disabled={isOpeningWorkspace} title="Open folder as workspace" aria-label="Open folder as workspace"><Icon name="folder-open" size={15} /></button>
          <button className="icon-button compact" onClick={() => inputRef.current?.click()} disabled={!workspaceRoot} title="Import files" aria-label="Import files"><Icon name="upload" size={15} /></button>
          <button className="icon-button compact" onClick={() => void loadRoot()} title="Refresh explorer" aria-label="Refresh explorer"><Icon name="refresh" size={15} /></button>
        </div>
      </header>
      <input ref={inputRef} type="file" multiple className="visually-hidden" onChange={importFiles} />
      <div className="workspace-label" title={workspaceRoot || 'No workspace'}>{workspaceRoot.split('/').filter(Boolean).pop() || 'NO WORKSPACE'}</div>
      <div className="file-tree-body">
        {state === 'loading' && <div className="panel-empty"><span className="progress-line" /><span>Loading workspace</span></div>}
        {state === 'error' && <div className="panel-empty"><Icon name="warning" /><strong>Workspace unavailable</strong><button className="text-button" onClick={() => void loadRoot()}>Try again</button></div>}
        {state === 'ready' && rootNodes.length === 0 && <div className="panel-empty"><Icon name="files" /><strong>{workspaceRoot ? 'Empty workspace' : 'No workspace connected'}</strong><span>{workspaceRoot ? 'Import a file to get started.' : 'Choose a folder to use as the workspace.'}</span>{!workspaceRoot && <button className="button primary compact-button" onClick={() => void chooseWorkspace()} disabled={isOpeningWorkspace}>{isOpeningWorkspace ? 'Opening folder' : 'Open Folder'}</button>}</div>}
        {state === 'ready' && rootNodes.map((node) => renderNode(node, 0))}
      </div>
    </section>
  );
}
