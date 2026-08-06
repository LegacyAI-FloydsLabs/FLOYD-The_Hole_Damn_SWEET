// CURSE'M IDE — Editor Adapter Interface (§3).
//
// §3: "The editor implementation should be behind an adapter so it is
//       not permanently coupled to Monaco internals."
//
// This interface abstracts all editor capabilities. MonacoAdapter is the
// primary implementation, but the interface allows swapping to a different
// engine without changing dependent code.

import type { Diagnostic, Theme } from '@/platform';
import type { LspService } from '@/lsp/LspService';
import type { InlineCompletionService } from './InlineCompletionService';
import type { DocumentType } from './fileRouting';

export interface EditorModel {
  path: string;
  languageId: string;
  content: string;
  version: number;
}

export interface Tab {
  path: string;
  isDirty: boolean;
  isPreview: boolean;
  /** 'document' tabs render a viewer (image/PDF/DOCX/binary) instead of Monaco. */
  kind?: 'editor' | 'document';
  documentType?: DocumentType;
}

export interface EditorSelection {
  path: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface InlineEditRequestDetail extends EditorSelection {
  languageId: string;
  fullContent: string;
  selectedText: string;
}

export interface FindOptions {
  matchCase?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

export interface ReplaceOptions extends FindOptions {
  preserveCase?: boolean;
}

export interface FindResult {
  matches: number;
  currentMatch: number;
}

export interface EditorOptions {
  minimap?: boolean;
  fontSize?: number;
  wordWrap?: 'off' | 'on' | 'wordWrapColumn';
  tabSize?: number;
  insertSpaces?: boolean;
  lineNumbers?: 'on' | 'off' | 'relative';
  folding?: boolean;
  renderWhitespace?: 'none' | 'boundary' | 'selection' | 'all';
  bracketPairColorization?: boolean;
  automaticLayout?: boolean;
  scrollBeyondLastLine?: boolean;
}

/** The editor adapter — decouples editor engine from the IDE. */
export interface EditorAdapter {
  // Lifecycle
  init(container: HTMLElement): void;
  dispose(): void;

  // Model management
  openFile(path: string, content: string, languageId?: string): void;
  closeFile(path: string): void;
  setActiveFile(path: string): void;
  getActiveFile(): string | null;
  getContent(path: string): string | null;
  setContent(path: string, content: string): void;

  // Diagnostics (§3)
  setDiagnostics(path: string, diagnostics: Diagnostic[]): void;
  bindLanguageServices?(service: LspService): void;
  bindInlineCompletion?(service: InlineCompletionService): void;
  clearDiagnostics(path: string): void;

  // Theme (§3: Floyd theme integration)
  applyTheme(theme: Theme): void;

  // Options (§3: minimap toggle, folding, etc.)
  setOption(key: string, value: unknown): void;
  getOption(key: string): unknown;

  // Commands (§3: configurable keybindings, command palette)
  registerCommand(id: string, handler: () => void, keybinding?: string): void;
  executeCommand(command: string): Promise<void>;

  // Find/replace (§3)
  find(query: string, options?: FindOptions): FindResult;
  replace(query: string, replacement: string, options?: ReplaceOptions): void;

  // Diff view (§3: diff and merge views)
  showDiff(original: string, modified: string, languageId: string): void;
  closeDiff(): void;

  // Events
  onContentChange(handler: (path: string, content: string) => void): () => void;
  onSelectionChange(handler: (selection: EditorSelection) => void): () => void;
  onInlineEdit(handler: (request: InlineEditRequestDetail) => void): () => void;
  onSave(handler: (path: string) => void): () => void;
}

/** Map file extensions to language IDs. */
export function detectLanguage(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript',
    mjs: 'javascript', cjs: 'javascript',
    json: 'json', jsonc: 'json',
    html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less',
    md: 'markdown', markdown: 'markdown',
    py: 'python',
    sh: 'shell', bash: 'shell',
    rs: 'rust',
    go: 'go',
    yaml: 'yaml', yml: 'yaml',
    xml: 'xml',
    sql: 'sql',
    toml: 'ini',
    dockerfile: 'dockerfile',
  };
  return map[ext] || 'plaintext';
}
