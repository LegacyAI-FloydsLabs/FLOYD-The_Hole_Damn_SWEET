import { useEditorStore } from '@/store/editorStore';
import { detectLanguage } from '@/editor';
import { useWorkspace } from '@/workspace';

export function StatusBar() {
  const { tabs, activeTabPath, cursor } = useEditorStore();
  const { workspaceId } = useWorkspace();
  const activeTab = tabs.find((tab) => tab.path === activeTabPath);

  return (
    <footer className="status-bar">
      <div className="status-bar-left">
        <span className="status-brand">CURSEM</span>
        <span className="status-item">{workspaceId || 'No workspace'}</span>
        {activeTab?.isDirty && <span className="status-item status-warning">Unsaved</span>}
      </div>
      <div className="status-bar-right">
        {activeTabPath && <><span className="status-item">Ln {cursor.line}, Col {cursor.column}</span><span className="status-item">UTF-8</span><span className="status-item">{detectLanguage(activeTabPath)}</span></>}
      </div>
    </footer>
  );
}
