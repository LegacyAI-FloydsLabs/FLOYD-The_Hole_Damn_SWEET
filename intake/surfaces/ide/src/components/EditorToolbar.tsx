import { Icon } from './Icon';
import { useEditorStore } from '@/store/editorStore';
import { useUIStore } from '@/store/uiStore';
import { dispatchEditorCommand } from '@/editor/commands';
import { isMarkdownPath } from '@/editor/fileRouting';

export function EditorToolbar() {
  const activeTabPath = useEditorStore((state) => state.activeTabPath);
  const activeTab = useEditorStore((state) => state.tabs.find((tab) => tab.path === state.activeTabPath));
  const previewOn = useEditorStore((state) => (state.activeTabPath ? !!state.markdownPreview[state.activeTabPath] : false));
  const toggleMarkdownPreview = useEditorStore((state) => state.toggleMarkdownPreview);
  const addToast = useUIStore((state) => state.addToast);
  if (!activeTabPath) return null;
  const pieces = activeTabPath.split('/').filter(Boolean);
  const isDocument = activeTab?.kind === 'document';
  const showMarkdownToggle = !isDocument && isMarkdownPath(activeTabPath);

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(activeTabPath);
      addToast('Copied active file path.', 'success');
    } catch {
      addToast('Clipboard permission was denied.', 'error');
    }
  };

  return (
    <div className="editor-toolbar">
      <div className="breadcrumbs" aria-label="Active file path">
        {pieces.slice(-4).map((piece, index, visible) => <span key={`${piece}-${index}`}>{piece}{index < visible.length - 1 && <Icon name="chevron-right" size={12} />}</span>)}
      </div>
      <div className="editor-actions">
        {showMarkdownToggle && (
          <button
            className={`text-button markdown-toggle ${previewOn ? 'active' : ''}`}
            onClick={() => toggleMarkdownPreview(activeTabPath)}
            title={previewOn ? 'Back to source' : 'Rendered preview'}
            aria-pressed={previewOn}
          >
            <Icon name="eye" size={13} /> {previewOn ? 'Source' : 'Preview'}
          </button>
        )}
        {!isDocument && <button className="icon-button compact" onClick={() => dispatchEditorCommand('inlineEdit')} title="CURSEM Inline Edit (⌘K)" aria-label="CURSEM Inline Edit"><Icon name="spark" size={15} /></button>}
        {!isDocument && <button className="icon-button compact" onClick={() => dispatchEditorCommand('undo')} title="Undo" aria-label="Undo"><Icon name="undo" size={15} /></button>}
        {!isDocument && <button className="icon-button compact" onClick={() => dispatchEditorCommand('redo')} title="Redo" aria-label="Redo"><Icon name="redo" size={15} /></button>}
        <button className="icon-button compact" onClick={copyPath} title="Copy file path" aria-label="Copy file path"><Icon name="copy" size={15} /></button>
        {!isDocument && <button className="icon-button compact" onClick={() => dispatchEditorCommand('export')} title="Export active file" aria-label="Export active file"><Icon name="download" size={15} /></button>}
      </div>
    </div>
  );
}
