import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { EditorAdapter } from './types';
import type { EditorCommand } from './commands';
import { useWorkspace } from '@/workspace';
import { useEditorStore } from '@/store/editorStore';
import { useUIStore } from '@/store/uiStore';
import { usePlatform } from '@/platform';
import { WelcomeScreen } from '@/components/WelcomeScreen';
import { toPlatformTheme } from '@/theme';
import { fontStack } from '@/font';
import { LspService } from '@/lsp';
import { detectLanguage } from './types';
import { isMarkdownPath } from './fileRouting';
import { MarkdownPreview } from './MarkdownPreview';
import { InlineCompletionService } from './InlineCompletionService';

const DocumentPane = lazy(() => import('./DocumentPane').then((module) => ({ default: module.DocumentPane })));

export function EditorPane() {
  const containerRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<EditorAdapter | null>(null);
  const lspRef = useRef<LspService | null>(null);
  const saveActiveRef = useRef<(() => Promise<void>) | null>(null);
  const previewSyncRef = useRef<((path: string, content: string) => void) | null>(null);
  const autosaveTimers = useRef(new Map<string, number>());
  const preferencesRef = useRef(useUIStore.getState().preferences);
  const { fs } = useWorkspace();
  const { gateway } = usePlatform();
  const { activeTabPath, tabs, markDirty, setCursor } = useEditorStore();
  const markdownPreview = useEditorStore((state) => state.markdownPreview);
  const preferences = useUIStore((state) => state.preferences);
  const addToast = useUIStore((state) => state.addToast);
  const [previewContent, setPreviewContent] = useState('');
  preferencesRef.current = preferences;

  const activeTab = activeTabPath ? tabs.find((tab) => tab.path === activeTabPath) : undefined;
  const isDocumentTab = activeTab?.kind === 'document';
  const previewActive = !!activeTabPath && !isDocumentTab && isMarkdownPath(activeTabPath) && !!markdownPreview[activeTabPath];

  // Live preview content: prefer the Monaco model, fall back to disk.
  previewSyncRef.current = (path, content) => {
    if (path === activeTabPath && markdownPreview[path]) setPreviewContent(content);
  };

  useEffect(() => {
    if (!previewActive || !activeTabPath) return;
    const existing = adapterRef.current?.getContent(activeTabPath);
    if (existing != null) {
      setPreviewContent(existing);
      return;
    }
    let cancelled = false;
    fs.readFile(activeTabPath)
      .then((content) => { if (!cancelled) setPreviewContent(content); })
      .catch(() => { if (!cancelled) setPreviewContent(''); });
    return () => { cancelled = true; };
  }, [previewActive, activeTabPath, fs]);

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let adapter: EditorAdapter | null = null;
    let lsp: LspService | null = null;

    const saveFile = async (path: string, quiet = false) => {
      if (!adapter) return;
      const prefs = preferencesRef.current;
      if (prefs.formatOnSave && adapter.getActiveFile() === path) await adapter.executeCommand('format');
      let content = adapter.getContent(path);
      if (content === null) return;
      if (prefs.trimTrailingWhitespace) content = content.replace(/[ \t]+$/gm, '');
      if (prefs.insertFinalNewline && content.length > 0 && !content.endsWith('\n')) content += '\n';
      try {
        if (adapter.getContent(path) !== content) adapter.setContent(path, content);
        await fs.writeFile(path, content);
        markDirty(path, false);
        gateway.emit({ type: 'file.saved', path });
        if (!quiet) addToast(`Saved ${path.split('/').pop()}.`, 'success');
      } catch (error) {
        addToast(error instanceof Error ? error.message : `Could not save ${path}.`, 'error');
      }
    };
    saveActiveRef.current = async () => {
      const path = adapter?.getActiveFile();
      if (path) await saveFile(path);
    };

    import('./MonacoAdapter').then(({ MonacoAdapter }) => {
      if (disposed || !containerRef.current) return;
      adapter = new MonacoAdapter();
      adapter.init(containerRef.current);
      lsp = new LspService(gateway);
      lspRef.current = lsp;
      adapter.bindLanguageServices?.(lsp);
      adapter.bindInlineCompletion?.(new InlineCompletionService());
      lsp.onDiagnostics((path, diagnostics) => adapter?.setDiagnostics(path, diagnostics));
      adapterRef.current = adapter;
      adapter.onContentChange((path, content) => {
        markDirty(path, true);
        fs.saveBuffer(path, content);
        previewSyncRef.current?.(path, content);
        lsp?.changeDocument(detectLanguage(path), path, content);
        const previous = autosaveTimers.current.get(path);
        if (previous) window.clearTimeout(previous);
        if (preferencesRef.current.autoSave) {
          const timer = window.setTimeout(() => {
            autosaveTimers.current.delete(path);
            void saveFile(path, true);
          }, preferencesRef.current.autoSaveDelay);
          autosaveTimers.current.set(path, timer);
        }
      });
      adapter.onSave((path) => { void saveFile(path); });
      adapter.onSelectionChange((selection) => {
        setCursor(selection.endLine, selection.endCol);
        gateway.emit({ type: 'selection.changed', path: selection.path, startLine: selection.startLine, endLine: selection.endLine, startCol: selection.startCol, endCol: selection.endCol });
      });
      adapter.onInlineEdit((request) => {
        // Inline Edit checkpoints are server-owned, so first make the current
        // editor buffer the canonical disk base. This intentionally behaves
        // like Save + Inline Edit and prevents a checkpoint from omitting
        // unsaved user work that preceded the selection transformation.
        void fs.writeFile(request.path, request.fullContent).then(() => {
          markDirty(request.path, false);
          window.dispatchEvent(new CustomEvent('cursem:inline-edit-requested', { detail: request }));
        }).catch((error) => addToast(error instanceof Error ? error.message : 'Could not save before Inline Edit.', 'error'));
      });

      const currentPath = useEditorStore.getState().activeTabPath;
      if (currentPath && useEditorStore.getState().getTab(currentPath)?.kind !== 'document') void loadPath(currentPath, adapter);
      applyPreferences(adapter);
    }).catch((error) => addToast(error instanceof Error ? error.message : 'Editor engine failed to load.', 'error'));

    const loadPath = async (path: string, target: EditorAdapter) => {
      if (target.getContent(path) !== null) { target.setActiveFile(path); return; }
      try {
        const content = await fs.readFile(path);
        const recovered = fs.recoverBuffer(path);
        target.openFile(path, recovered ?? content, undefined);
        target.setActiveFile(path);
        if (recovered !== null && recovered !== content) {
          markDirty(path, true);
          addToast(`Recovered unsaved changes for ${path.split('/').pop()}.`, 'warning');
        }
        gateway.emit({ type: 'file.opened', path });
        gateway.emit({ type: 'file.selected', path });
        void lsp?.openDocument(detectLanguage(path), path, recovered ?? content).catch(() => undefined);
      } catch (error) {
        addToast(error instanceof Error ? error.message : `Could not open ${path}.`, 'error');
      }
    };

    return () => {
      disposed = true;
      for (const timer of autosaveTimers.current.values()) window.clearTimeout(timer);
      autosaveTimers.current.clear();
      adapter?.dispose();
      lsp?.dispose();
      lspRef.current = null;
      adapterRef.current = null;
      saveActiveRef.current = null;
    };
  }, [addToast, fs, gateway, markDirty, setCursor]);

  const applyPreferences = (adapter: EditorAdapter) => {
    adapter.applyTheme(toPlatformTheme(preferences.theme));
    adapter.setOption('fontFamily', fontStack(preferences.fontFamily));
    adapter.setOption('fontSize', preferences.fontSize);
    adapter.setOption('lineHeight', preferences.lineHeight);
    adapter.setOption('wordWrap', preferences.wordWrap ? 'on' : 'off');
    adapter.setOption('minimap', { enabled: preferences.minimap });
  };

  useEffect(() => {
    if (adapterRef.current) applyPreferences(adapterRef.current);
  }, [preferences]);

  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter || !activeTabPath || isDocumentTab) return;
    if (adapter.getContent(activeTabPath) !== null) {
      adapter.setActiveFile(activeTabPath);
      gateway.emit({ type: 'file.selected', path: activeTabPath });
      return;
    }
    fs.readFile(activeTabPath).then((content) => {
      const recovered = fs.recoverBuffer(activeTabPath);
      adapter.openFile(activeTabPath, recovered ?? content, undefined);
      adapter.setActiveFile(activeTabPath);
      if (recovered !== null && recovered !== content) markDirty(activeTabPath, true);
      gateway.emit({ type: 'file.opened', path: activeTabPath });
      gateway.emit({ type: 'file.selected', path: activeTabPath });
      void lspRef.current?.openDocument(detectLanguage(activeTabPath), activeTabPath, recovered ?? content).catch(() => undefined);
    }).catch((error) => addToast(error instanceof Error ? error.message : `Could not open ${activeTabPath}.`, 'error'));
  }, [activeTabPath, addToast, fs, gateway, isDocumentTab, markDirty]);

  useEffect(() => {
    const listener = async (event: Event) => {
      const command = (event as CustomEvent<EditorCommand>).detail;
      const adapter = adapterRef.current;
      if (!adapter) return;
      if (command === 'save') {
        await saveActiveRef.current?.();
        return;
      }
      if (command === 'export') {
        const path = adapter.getActiveFile();
        if (!path) return;
        const content = adapter.getContent(path);
        if (content === null) return;
        const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = path.split('/').pop() || 'export.txt';
        anchor.click();
        URL.revokeObjectURL(url);
        addToast(`Exported ${anchor.download}.`, 'success');
        return;
      }
      await adapter.executeCommand(command);
    };
    window.addEventListener('cursem:editor-command', listener);
    return () => window.removeEventListener('cursem:editor-command', listener);
  }, [addToast]);

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; content?: string }>).detail;
      if (!detail || typeof detail.path !== 'string' || typeof detail.content !== 'string') return;
      const adapter = adapterRef.current;
      if (!adapter || adapter.getContent(detail.path) === null) return;
      adapter.setContent(detail.path, detail.content);
      markDirty(detail.path, false);
    };
    window.addEventListener('cursem:external-edit', listener);
    return () => window.removeEventListener('cursem:external-edit', listener);
  }, [markDirty]);

  return (
    <div className="editor-pane">
      <div ref={containerRef} className="monaco-container" />
      {isDocumentTab && activeTabPath && (
        <Suspense fallback={<div className="document-pane"><div className="panel-empty"><span className="progress-line" /><span>Loading viewer</span></div></div>}>
          <DocumentPane path={activeTabPath} />
        </Suspense>
      )}
      {previewActive && <MarkdownPreview content={previewContent} />}
      {!activeTabPath && <WelcomeScreen />}
      <span className="visually-hidden" aria-live="polite">{tabs.length} open editor{tabs.length === 1 ? '' : 's'}</span>
    </div>
  );
}
