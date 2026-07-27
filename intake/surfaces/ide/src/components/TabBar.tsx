import { useState, type MouseEvent } from 'react';
import { Icon } from './Icon';
import { useEditorStore } from '@/store/editorStore';

export function TabBar() {
  const { tabs, activeTabPath, closeTab, closeOtherTabs, setActiveTab, reorderTab } = useEditorStore();
  const [draggedPath, setDraggedPath] = useState<string | null>(null);

  const requestClose = (path: string, event?: MouseEvent) => {
    event?.stopPropagation();
    const tab = tabs.find((item) => item.path === path);
    if (tab?.isDirty && !window.confirm(`Close ${path.split('/').pop()} without saving?`)) return;
    closeTab(path);
  };

  if (tabs.length === 0) return null;

  return (
    <div className="tab-bar" role="tablist" aria-label="Open editors">
      {tabs.map((tab) => (
        <div
          key={tab.path}
          className={`tab ${tab.path === activeTabPath ? 'active' : ''} ${draggedPath === tab.path ? 'dragging' : ''}`}
          role="tab"
          aria-selected={tab.path === activeTabPath}
          tabIndex={tab.path === activeTabPath ? 0 : -1}
          draggable
          onDragStart={() => setDraggedPath(tab.path)}
          onDragEnd={() => setDraggedPath(null)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={() => { if (draggedPath) reorderTab(draggedPath, tab.path); setDraggedPath(null); }}
          onClick={() => setActiveTab(tab.path)}
          onAuxClick={(event) => event.button === 1 && requestClose(tab.path)}
          onDoubleClick={() => closeOtherTabs(tab.path)}
          title={`${tab.path}\nDouble-click to close other editors`}
        >
          <span className={`tab-file-glyph type-${tab.path.split('.').pop()?.toLowerCase()}`}>{(tab.path.split('.').pop() || 'TXT').slice(0, 2).toUpperCase()}</span>
          <span className="tab-name">{tab.path.split('/').pop()}</span>
          {tab.isDirty && <span className="tab-dirty" aria-label="Unsaved changes" />}
          <button className="tab-close" onClick={(event) => requestClose(tab.path, event)} aria-label={`Close ${tab.path.split('/').pop()}`}><Icon name="close" size={14} /></button>
        </div>
      ))}
    </div>
  );
}
