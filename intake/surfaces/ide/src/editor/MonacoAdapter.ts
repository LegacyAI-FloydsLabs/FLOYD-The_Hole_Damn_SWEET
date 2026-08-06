// CURSE'M IDE — Monaco Editor Adapter (§3).
//
// Implements the EditorAdapter interface using Monaco Editor.
// This is the ONLY file that imports monaco-editor directly — all other
// code interacts with the editor through the adapter interface.
//
// §3 Required editor functions implemented here:
//   - tabs and split panes (via model management + store)
//   - syntax highlighting (Monaco built-in)
//   - completion (Monaco built-in + LSP injection via diagnostics)
//   - diagnostics (setModelMarkers)
//   - definitions and references (via LSP commands)
//   - rename/refactoring (via LSP commands)
//   - hover documentation (Monaco built-in + LSP)
//   - formatting (Monaco built-in + LSP)
//   - search and replace (Monaco find widget)
//   - folding (Monaco built-in)
//   - minimap toggle (updateOptions)
//   - breadcrumbs (Monaco built-in)
//   - diff and merge views (createDiffEditor)
//   - autosave and explicit save (Cmd+S handler)
//   - configurable keybindings (addCommand)
//   - Floyd theme integration (defineTheme + applyTheme)

import * as monaco from 'monaco-editor';
import './monacoWorkers';
import type {
  EditorAdapter,
  EditorSelection,
  InlineEditRequestDetail,
  FindOptions,
  FindResult,
  ReplaceOptions,
} from './types';
import { detectLanguage, registerEditorAdapter } from './types';
import type { Diagnostic, Theme } from '@/platform';
import type { LspService } from '@/lsp/LspService';
import { SUPPORTED_LANGUAGES } from '@/platform/types';
import type { InlineCompletionService } from './InlineCompletionService';

function toMarkers(diagnostics: Diagnostic[]): monaco.editor.IMarkerData[] {
  return diagnostics.map((d) => ({
    startLineNumber: d.line,
    startColumn: d.col + 1,
    endLineNumber: d.endLine ?? d.line,
    endColumn: (d.endCol ?? d.col) + 1,
    message: d.message,
    severity:
      d.severity === 'error'
        ? monaco.MarkerSeverity.Error
        : d.severity === 'warning'
          ? monaco.MarkerSeverity.Warning
          : d.severity === 'info'
            ? monaco.MarkerSeverity.Info
            : monaco.MarkerSeverity.Hint,
    source: d.source,
    code: d.code,
  }));
}

function monacoColor(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const match = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (!match) return value;
  const toHex = (part: string) => Number(part).toString(16).padStart(2, '0');
  const alpha = Math.round(Number(match[4] ?? 1) * 255).toString(16).padStart(2, '0');
  return `#${toHex(match[1])}${toHex(match[2])}${toHex(match[3])}${alpha}`;
}

function syntaxColor(value: string | undefined, fallback: string): string {
  return monacoColor(value, fallback).replace('#', '').slice(0, 6);
}

export class MonacoAdapter implements EditorAdapter {
  private editor: monaco.editor.IStandaloneCodeEditor | null = null;
  private diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
  private models = new Map<string, monaco.editor.ITextModel>();
  private container: HTMLElement | null = null;
  private options: Record<string, unknown> = {};

  private contentChangeHandlers: Array<(path: string, content: string) => void> = [];
  private selectionChangeHandlers: Array<(selection: EditorSelection) => void> = [];
  private inlineEditHandlers: Array<(request: InlineEditRequestDetail) => void> = [];
  private saveHandlers: Array<(path: string) => void> = [];
  private activePath: string | null = null;
  private currentTheme = 'cursem-dark';
  private lspDisposables: monaco.IDisposable[] = [];
  private inlineDisposables: monaco.IDisposable[] = [];

  init(container: HTMLElement): void {
    this.container = container;
    registerEditorAdapter(this);
    this.defineDefaultThemes();
    this.editor = monaco.editor.create(container, {
      theme: 'cursem-dark',
      fontFamily: '"Phantasy Mono PTY", "JetBrains Mono", Menlo, monospace',
      fontSize: 14,
      lineHeight: 22,
      minimap: { enabled: true },
      automaticLayout: true,
      tabSize: 2,
      insertSpaces: true,
      wordWrap: 'on',
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
    });

    // §3: "autosave and explicit save" — Cmd+S / Ctrl+S
    this.editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => {
        if (this.activePath) {
          for (const h of this.saveHandlers) h(this.activePath);
        }
      },
    );

    this.editor.addAction({
      id: 'cursem.inlineEdit',
      label: 'CURSEM: Edit Selection',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK],
      contextMenuGroupId: 'modification',
      run: (editor) => {
        const model = editor.getModel(); let selection = editor.getSelection();
        if (!model || !selection || !this.activePath) return;
        if (selection.isEmpty()) {
          const line = model.getLineContent(selection.startLineNumber);
          selection = new monaco.Selection(selection.startLineNumber, 1, selection.startLineNumber, line.length + 1);
        }
        const request: InlineEditRequestDetail = {
          path: this.activePath, languageId: model.getLanguageId(), fullContent: model.getValue(), selectedText: model.getValueInRange(selection),
          startLine: selection.startLineNumber, startCol: selection.startColumn,
          endLine: selection.endLineNumber, endCol: selection.endColumn,
        };
        for (const handler of this.inlineEditHandlers) handler(request);
      },
    });

    // Content change → notify handlers
    this.editor.onDidChangeModelContent(() => {
      if (!this.activePath) return;
      const model = this.models.get(this.activePath);
      if (!model) return;
      const content = model.getValue();
      for (const h of this.contentChangeHandlers) {
        h(this.activePath, content);
      }
    });

    // Selection change → emit host event (§8: selection.changed)
    this.editor.onDidChangeCursorSelection((e) => {
      if (!this.activePath) return;
      const sel: EditorSelection = {
        path: this.activePath,
        startLine: e.selection.startLineNumber,
        startCol: e.selection.startColumn,
        endLine: e.selection.endLineNumber,
        endCol: e.selection.endColumn,
      };
      for (const h of this.selectionChangeHandlers) h(sel);
    });
  }

  private defineDefaultThemes(): void {
    monaco.editor.defineTheme('cursem-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '768098', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'FF5FA2' },
        { token: 'string', foreground: '77E7F5' },
        { token: 'number', foreground: 'C09BFF' },
        { token: 'type', foreground: 'FFE08A' },
        { token: 'function', foreground: '73B9FF' },
      ],
      colors: {
        'editor.background': '#0B0912',
        'editor.foreground': '#E9E7EE',
        'editorLineNumber.foreground': '#575268',
        'editorLineNumber.activeForeground': '#B8F5FB',
        'editor.selectionBackground': '#4F234F',
        'editor.inactiveSelectionBackground': '#291D35',
        'editor.lineHighlightBackground': '#12101B',
        'editorCursor.foreground': '#25D9F5',
        'editorWhitespace.foreground': '#302B3D',
        'editorIndentGuide.background1': '#24202F',
        'editorIndentGuide.activeBackground1': '#F72585',
      },
    });
    monaco.editor.defineTheme('cursem-light', {
      base: 'vs', inherit: true,
      rules: [
        { token: 'comment', foreground: '6E6A78', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'B80D5B' },
        { token: 'string', foreground: '006B79' },
        { token: 'number', foreground: '6541A5' },
        { token: 'function', foreground: '075AA3' },
      ],
      colors: {
        'editor.background': '#FBF9FC', 'editor.foreground': '#211E29',
        'editorLineNumber.foreground': '#8B8497', 'editorCursor.foreground': '#B80D5B',
        'editor.selectionBackground': '#F3B9D5', 'editor.lineHighlightBackground': '#F4F0F6',
      },
    });
    monaco.editor.defineTheme('cursem-contrast', {
      base: 'hc-black', inherit: true,
      rules: [{ token: 'keyword', foreground: 'FF71B0' }, { token: 'string', foreground: '64F2FF' }],
      colors: { 'editor.background': '#000000', 'editor.foreground': '#FFFFFF', 'editorCursor.foreground': '#00F0FF', 'editor.selectionBackground': '#8A0050' },
    });
  }

  dispose(): void {
    registerEditorAdapter(null);
    for (const model of this.models.values()) model.dispose();
    this.models.clear();
    this.editor?.dispose();
    this.diffEditor?.dispose();
    this.editor = null;
    this.diffEditor = null;
    this.container = null;
    this.contentChangeHandlers = [];
    this.selectionChangeHandlers = [];
    this.inlineEditHandlers = [];
    this.saveHandlers = [];
    for (const disposable of this.lspDisposables) disposable.dispose();
    this.lspDisposables = [];
    for (const disposable of this.inlineDisposables) disposable.dispose();
    this.inlineDisposables = [];
  }

  bindInlineCompletion(service: InlineCompletionService): void {
    for (const disposable of this.inlineDisposables) disposable.dispose();
    this.inlineDisposables = [];
    const languageIds = new Set([...SUPPORTED_LANGUAGES, 'go', 'java', 'c', 'cpp', 'csharp', 'ruby', 'php', 'yaml', 'sql']);
    for (const languageId of languageIds) {
      this.inlineDisposables.push(monaco.languages.registerInlineCompletionsProvider(languageId, {
        provideInlineCompletions: async (model, position, _context, token) => {
          const controller = new AbortController();
          const cancellation = token.onCancellationRequested(() => controller.abort());
          try {
            const value = model.getValue(); const offset = model.getOffsetAt(position);
            const completion = await service.suggest({ path: model.uri.fsPath, languageId: model.getLanguageId(), prefix: value.slice(0, offset), suffix: value.slice(offset), signal: controller.signal });
            if (!completion || token.isCancellationRequested) return { items: [] };
            return { items: [{ insertText: completion, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] };
          } finally { cancellation.dispose(); }
        },
        disposeInlineCompletions: () => undefined,
      }));
    }
  }

  bindLanguageServices(service: LspService): void {
    for (const disposable of this.lspDisposables) disposable.dispose();
    this.lspDisposables = [];
    for (const languageId of SUPPORTED_LANGUAGES) {
      this.lspDisposables.push(monaco.languages.registerCompletionItemProvider(languageId, {
        triggerCharacters: ['.', '/', '"', "'"],
        provideCompletionItems: async (model, position) => {
          const items = await service.requestCompletion(languageId, model.uri.fsPath, position.lineNumber, position.column - 1);
          return {
            suggestions: items.map((item) => ({
              label: item.label,
              detail: item.detail,
              documentation: item.documentation,
              insertText: item.insertText || item.label,
              kind: (item.kind || monaco.languages.CompletionItemKind.Text) as monaco.languages.CompletionItemKind,
              range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
            })),
          };
        },
      }));
      this.lspDisposables.push(monaco.languages.registerHoverProvider(languageId, {
        provideHover: async (model, position) => {
          const result = await service.requestHover(languageId, model.uri.fsPath, position.lineNumber, position.column - 1);
          return result ? { contents: [{ value: result.contents }] } : null;
        },
      }));
      this.lspDisposables.push(monaco.languages.registerDefinitionProvider(languageId, {
        provideDefinition: async (model, position) => (await service.requestDefinition(languageId, model.uri.fsPath, position.lineNumber, position.column - 1)).map(toMonacoLocation),
      }));
      this.lspDisposables.push(monaco.languages.registerReferenceProvider(languageId, {
        provideReferences: async (model, position) => (await service.requestReferences(languageId, model.uri.fsPath, position.lineNumber, position.column - 1)).map(toMonacoLocation),
      }));
      this.lspDisposables.push(monaco.languages.registerRenameProvider(languageId, {
        provideRenameEdits: async (model, position, newName) => {
          const files = await service.requestRename(languageId, model.uri.fsPath, position.lineNumber, position.column - 1, newName);
          return { edits: files.flatMap((file) => file.edits.map((edit) => ({ resource: monaco.Uri.file(file.path), textEdit: { range: toMonacoRange(edit), text: edit.text }, versionId: undefined }))) };
        },
        resolveRenameLocation: (_model, position) => ({ range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: '' }),
      }));
      this.lspDisposables.push(monaco.languages.registerDocumentFormattingEditProvider(languageId, {
        provideDocumentFormattingEdits: async (model) => (await service.requestFormatting(languageId, model.uri.fsPath)).map((edit) => ({ range: toMonacoRange(edit), text: edit.text })),
      }));
    }
  }

  openFile(path: string, content: string, languageId?: string): void {
    const lang = languageId || detectLanguage(path);
    const uri = monaco.Uri.parse(`file://${path}`);

    let model = monaco.editor.getModel(uri);
    if (!model) {
      model = monaco.editor.createModel(content, lang, uri);
    } else if (model.getValue() !== content) {
      model.setValue(content);
    }
    this.models.set(path, model);
  }

  closeFile(path: string): void {
    const model = this.models.get(path);
    if (model) {
      model.dispose();
      this.models.delete(path);
    }
    if (this.activePath === path) this.activePath = null;
  }

  setActiveFile(path: string): void {
    const model = this.models.get(path);
    if (!model || !this.editor) return;
    this.closeDiff();
    this.editor.setModel(model);
    this.activePath = path;
  }

  getActiveFile(): string | null {
    return this.activePath;
  }

  revealPosition(path: string, line: number, column: number): void {
    if (!this.editor || this.activePath !== path) return;
    this.editor.revealLineInCenter(line);
    this.editor.setPosition({ lineNumber: line, column });
    this.editor.focus();
  }

  getContent(path: string): string | null {
    const model = this.models.get(path);
    return model ? model.getValue() : null;
  }

  setContent(path: string, content: string): void {
    const model = this.models.get(path);
    if (model) model.setValue(content);
  }

  setDiagnostics(path: string, diagnostics: Diagnostic[]): void {
    const model = this.models.get(path);
    if (model) {
      monaco.editor.setModelMarkers(model, 'cursem', toMarkers(diagnostics));
    }
  }

  clearDiagnostics(path: string): void {
    const model = this.models.get(path);
    if (model) monaco.editor.setModelMarkers(model, 'cursem', []);
  }

  applyTheme(theme: Theme): void {
    if (theme.monacoTheme) {
      monaco.editor.setTheme(theme.monacoTheme);
      this.currentTheme = theme.monacoTheme;
      return;
    }
    // Single stable name (ported from Cate): redefining 'cursem-active'
    // re-themes every open editor, including diff editors, without
    // accumulating a stale definition per theme id.
    const name = 'cursem-active';
    const colors: Record<string, string> = {
      'editor.background': monacoColor(theme.colors['editor.background'], theme.isDark ? '#0d1117' : '#ffffff'),
      'editor.foreground': monacoColor(theme.colors['editor.foreground'], theme.isDark ? '#c9d1d9' : '#24292e'),
      'editorLineNumber.foreground': monacoColor(theme.colors['editorLineNumber.foreground'], '#6e7681'),
      'editorLineNumber.activeForeground': monacoColor(theme.colors['editorLineNumber.activeForeground'], '#c9d1d9'),
      'editorCursor.foreground': monacoColor(theme.colors['editorCursor.foreground'], '#58a6ff'),
      'editor.selectionBackground': monacoColor(theme.colors['editor.selectionBackground'], '#264f78'),
      'editor.inactiveSelectionBackground': monacoColor(theme.colors['editor.inactiveSelectionBackground'], '#264f7855'),
      'editor.lineHighlightBackground': monacoColor(theme.colors['editor.lineHighlightBackground'], '#161b22'),
      'editorWhitespace.foreground': monacoColor(theme.colors['editorWhitespace.foreground'], '#30363d'),
      'editorIndentGuide.background1': monacoColor(theme.colors['editorIndentGuide.background1'], '#30363d'),
      'editorIndentGuide.activeBackground1': monacoColor(theme.colors['editorIndentGuide.activeBackground1'], '#58a6ff'),
    };
    // Unified themes may carry extra Monaco IColors (gutter, minimap, …).
    for (const [key, value] of Object.entries(theme.colors)) {
      if (key.startsWith('syntax.')) continue;
      colors[key] = monacoColor(value, colors[key] ?? value);
    }
    monaco.editor.defineTheme(name, {
      base: theme.editorBase ?? (theme.isDark ? 'vs-dark' : 'vs'),
      inherit: true,
      rules: theme.editorRules ?? [
        { token: 'comment', foreground: syntaxColor(theme.colors['syntax.comment'], '768098'), fontStyle: 'italic' },
        { token: 'keyword', foreground: syntaxColor(theme.colors['syntax.keyword'], 'FF5FA2') },
        { token: 'string', foreground: syntaxColor(theme.colors['syntax.string'], '77E7F5') },
        { token: 'number', foreground: syntaxColor(theme.colors['syntax.number'], 'C09BFF') },
        { token: 'function', foreground: syntaxColor(theme.colors['syntax.function'], '73B9FF') },
        { token: 'type', foreground: syntaxColor(theme.colors['syntax.type'], 'FFE08A') },
        { token: 'operator', foreground: syntaxColor(theme.colors['syntax.operator'], '25D9F5') },
      ],
      colors,
    });
    monaco.editor.setTheme(name);
    this.currentTheme = name;
  }

  setOption(key: string, value: unknown): void {
    if (!this.editor) return;
    this.options[key] = value;
    this.editor.updateOptions({ [key]: value } as monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions);
  }

  getOption(key: string): unknown {
    return this.options[key];
  }

  registerCommand(id: string, handler: () => void, _keybinding?: string): void {
    if (!this.editor) return;
    this.editor.addAction({ id, label: id, run: () => handler() });
  }

  async executeCommand(command: string): Promise<void> {
    const actionMap: Record<string, string> = {
      undo: 'undo', redo: 'redo', find: 'actions.find', replace: 'editor.action.startFindReplaceAction',
      format: 'editor.action.formatDocument', selectAll: 'editor.action.selectAll',
      copy: 'editor.action.clipboardCopyAction', paste: 'editor.action.clipboardPasteAction',
      inlineEdit: 'cursem.inlineEdit',
    };
    const action = this.editor?.getAction(actionMap[command] ?? command);
    if (action) await action.run();
  }

  find(_query: string, _options?: FindOptions): FindResult {
    // Monaco's find widget is triggered via action; this is a simplified interface.
    this.editor?.getAction('actions.find')?.run();
    return { matches: 0, currentMatch: 0 };
  }

  replace(_query: string, _replacement: string, _options?: ReplaceOptions): void {
    this.editor?.getAction('editor.action.startFindReplaceAction')?.run();
  }

  showDiff(original: string, modified: string, languageId: string): void {
    if (!this.container) return;
    this.closeDiff();

    if (this.editor) {
      this.editor.getDomNode()?.style.setProperty('display', 'none');
    }

    this.diffEditor = monaco.editor.createDiffEditor(this.container, {
      theme: this.currentTheme,
      automaticLayout: true,
    });

    const origModel = monaco.editor.createModel(original, languageId);
    const modModel = monaco.editor.createModel(modified, languageId);
    this.diffEditor.setModel({ original: origModel, modified: modModel });
  }

  closeDiff(): void {
    if (!this.diffEditor) return;
    const model = this.diffEditor.getModel();
    model?.original?.dispose();
    model?.modified?.dispose();
    this.diffEditor.dispose();
    this.diffEditor = null;
    if (this.editor) {
      this.editor.getDomNode()?.style.setProperty('display', '');
    }
  }

  onContentChange(handler: (path: string, content: string) => void): () => void {
    this.contentChangeHandlers.push(handler);
    return () => {
      const i = this.contentChangeHandlers.indexOf(handler);
      if (i >= 0) this.contentChangeHandlers.splice(i, 1);
    };
  }

  onSelectionChange(handler: (selection: EditorSelection) => void): () => void {
    this.selectionChangeHandlers.push(handler);
    return () => {
      const i = this.selectionChangeHandlers.indexOf(handler);
      if (i >= 0) this.selectionChangeHandlers.splice(i, 1);
    };
  }

  onInlineEdit(handler: (request: InlineEditRequestDetail) => void): () => void {
    this.inlineEditHandlers.push(handler);
    return () => { this.inlineEditHandlers = this.inlineEditHandlers.filter((item) => item !== handler); };
  }

  onSave(handler: (path: string) => void): () => void {
    this.saveHandlers.push(handler);
    return () => {
      const i = this.saveHandlers.indexOf(handler);
      if (i >= 0) this.saveHandlers.splice(i, 1);
    };
  }
}

function toMonacoRange(value: { line: number; col: number; endLine?: number; endCol?: number }): monaco.Range {
  return new monaco.Range(value.line, value.col + 1, value.endLine ?? value.line, (value.endCol ?? value.col) + 1);
}

function toMonacoLocation(value: { path: string; line: number; col: number; endLine?: number; endCol?: number }): monaco.languages.Location {
  return { uri: monaco.Uri.file(value.path), range: toMonacoRange(value) };
}
