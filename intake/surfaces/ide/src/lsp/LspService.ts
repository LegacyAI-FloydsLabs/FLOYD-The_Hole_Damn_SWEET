// CURSE'M IDE — LSP Service (§4).
//
// §4: "Connect to real language servers through a platform-managed LSP gateway."
// §4: "Do not run separate duplicate language servers for every browser tab."
// §4: "Expose language-server health and restart controls."
// §4: "Language services must use the same real workspace root as OpenCode."
//
// The LSP service manages connections to the platform-managed LSP gateway.
// It does NOT run language servers — the gateway does that. The IDE gets
// a multiplexed view of the shared language servers.

import type { HostGateway, LspConnection, LspHealth, LspServerInfo, Diagnostic } from '@/platform';

export const SUPPORTED_LSP_LANGUAGES = Object.freeze([
  'typescript',
  'javascript',
  'javascriptreact',
  'typescriptreact',
  'json',
  'html',
  'css',
  'python',
  'shell',
  'rust',
] as const);

const supportedLspLanguages = new Set<string>(SUPPORTED_LSP_LANGUAGES);

export function supportsLspLanguage(languageId: string): boolean {
  return supportedLspLanguages.has(languageId);
}

export interface CompletionItem {
  label: string;
  detail?: string;
  documentation?: string;
  insertText?: string;
  kind?: number;
}

export interface HoverResult {
  contents: string;
  range?: { startLine: number; startCol: number; endLine: number; endCol: number };
}

export interface LocationResult {
  path: string;
  line: number;
  col: number;
  endLine?: number;
  endCol?: number;
}

export class LspService {
  private gateway: HostGateway;
  private connections = new Map<string, LspConnection>();
  private diagnosticHandlers = new Set<(path: string, diagnostics: Diagnostic[]) => void>();
  private initialized = new Set<string>();
  private versions = new Map<string, number>();

  constructor(gateway: HostGateway) {
    this.gateway = gateway;
  }

  /** Ensure a connection exists for the given language. */
  async ensureConnection(languageId: string): Promise<LspConnection> {
    if (!supportsLspLanguage(languageId)) {
      throw new Error(`No language server is configured for ${languageId}.`);
    }
    const key = connectionKey(languageId);
    let conn = this.connections.get(key);
    if (conn) return conn;

    conn = await this.gateway.lspConnect(key);
    this.connections.set(key, conn);

    await conn.request('initialize', {
      processId: null,
      rootUri: `file://${this.gateway.config.workspaceRoot}`,
      workspaceFolders: [{ uri: `file://${this.gateway.config.workspaceRoot}`, name: this.gateway.config.workspaceId }],
      capabilities: {
        workspace: { workspaceFolders: true },
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: true },
          completion: { completionItem: { snippetSupport: true } },
          hover: {}, definition: {}, references: {}, rename: {}, formatting: {},
          publishDiagnostics: { relatedInformation: true },
        },
      },
    });
    conn.notify('initialized', {});
    this.initialized.add(key);

    // Subscribe to diagnostics from the LSP server
    conn.onNotification('textDocument/publishDiagnostics', (params: unknown) => {
      const p = params as { uri: string; diagnostics: unknown[] };
      const path = p.uri.replace('file://', '');
      const diagnostics = (p.diagnostics || []).map((d) => {
        const diag = d as {
          range: { start: { line: number; character: number }; end: { line: number; character: number } };
          severity: number;
          message: string;
          source?: string;
          code?: string;
        };
        return {
          path,
          line: diag.range.start.line + 1,
          col: diag.range.start.character,
          endLine: diag.range.end.line + 1,
          endCol: diag.range.end.character,
          severity: diag.severity === 1 ? 'error' as const
            : diag.severity === 2 ? 'warning' as const
            : diag.severity === 3 ? 'info' as const
            : 'hint' as const,
          message: diag.message,
          source: diag.source,
          code: diag.code,
        };
      });

      for (const handler of this.diagnosticHandlers) {
        handler(path, diagnostics);
      }
    });

    return conn;
  }

  async openDocument(languageId: string, path: string, text: string): Promise<void> {
    if (!supportsLspLanguage(languageId)) return;
    const conn = await this.ensureConnection(languageId);
    const version = 1;
    this.versions.set(path, version);
    conn.notify('textDocument/didOpen', { textDocument: { uri: `file://${path}`, languageId, version, text } });
  }

  changeDocument(languageId: string, path: string, text: string): void {
    if (!supportsLspLanguage(languageId)) return;
    const conn = this.connections.get(connectionKey(languageId));
    if (!conn || !this.versions.has(path)) return;
    const version = (this.versions.get(path) || 0) + 1;
    this.versions.set(path, version);
    conn.notify('textDocument/didChange', { textDocument: { uri: `file://${path}`, version }, contentChanges: [{ text }] });
  }

  /** Request completions at a position. */
  async requestCompletion(
    languageId: string,
    path: string,
    line: number,
    col: number,
  ): Promise<CompletionItem[]> {
    if (!supportsLspLanguage(languageId)) return [];
    const conn = await this.ensureConnection(languageId);
    try {
      const result = await conn.request('textDocument/completion', {
        textDocument: { uri: `file://${path}` },
        position: { line: line - 1, character: col },
      });
      const items = Array.isArray(result) ? result : (result as { items?: CompletionItem[] })?.items || [];
      return items as CompletionItem[];
    } catch {
      return [];
    }
  }

  /** Request hover information at a position. */
  async requestHover(
    languageId: string,
    path: string,
    line: number,
    col: number,
  ): Promise<HoverResult | null> {
    if (!supportsLspLanguage(languageId)) return null;
    const conn = await this.ensureConnection(languageId);
    try {
      const result = await conn.request('textDocument/hover', {
        textDocument: { uri: `file://${path}` },
        position: { line: line - 1, character: col },
      });
      if (!result) return null;
      const r = result as { contents?: string | { value?: string }; range?: unknown };
      const contents = typeof r.contents === 'string'
        ? r.contents
        : r.contents?.value || '';
      return { contents };
    } catch {
      return null;
    }
  }

  /** Request go-to-definition. */
  async requestDefinition(
    languageId: string,
    path: string,
    line: number,
    col: number,
  ): Promise<LocationResult[]> {
    if (!supportsLspLanguage(languageId)) return [];
    const conn = await this.ensureConnection(languageId);
    try {
      const result = await conn.request('textDocument/definition', {
        textDocument: { uri: `file://${path}` },
        position: { line: line - 1, character: col },
      });
      const locations = Array.isArray(result) ? result : [result];
      return locations
        .filter((l: unknown) => l !== null)
        .map((l) => {
          const loc = l as { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } };
          return {
            path: loc.uri.replace('file://', ''),
            line: loc.range.start.line + 1,
            col: loc.range.start.character,
            endLine: loc.range.end.line + 1,
            endCol: loc.range.end.character,
          };
        });
    } catch {
      return [];
    }
  }

  /** Request find references. */
  async requestReferences(
    languageId: string,
    path: string,
    line: number,
    col: number,
  ): Promise<LocationResult[]> {
    if (!supportsLspLanguage(languageId)) return [];
    const conn = await this.ensureConnection(languageId);
    try {
      const result = await conn.request('textDocument/references', {
        textDocument: { uri: `file://${path}` },
        position: { line: line - 1, character: col },
        context: { includeDeclaration: true },
      });
      const locations = (result || []) as unknown[];
      return locations.map((l) => {
        const loc = l as { uri: string; range: { start: { line: number; character: number } } };
        return {
          path: loc.uri.replace('file://', ''),
          line: loc.range.start.line + 1,
          col: loc.range.start.character,
        };
      });
    } catch {
      return [];
    }
  }

  /** Request rename symbol. */
  async requestRename(
    languageId: string,
    path: string,
    line: number,
    col: number,
    newName: string,
  ): Promise<Array<{ path: string; edits: Array<{ line: number; col: number; endLine: number; endCol: number; text: string }> }>> {
    if (!supportsLspLanguage(languageId)) return [];
    const conn = await this.ensureConnection(languageId);
    try {
      const result = await conn.request('textDocument/rename', {
        textDocument: { uri: `file://${path}` },
        position: { line: line - 1, character: col },
        newName,
      });
      const workspaceEdit = result as { changes?: Record<string, unknown[]> };
      if (!workspaceEdit?.changes) return [];

      return Object.entries(workspaceEdit.changes).map(([uri, edits]) => ({
        path: uri.replace('file://', ''),
        edits: edits.map((e) => {
          const edit = e as { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string };
          return {
            line: edit.range.start.line + 1,
            col: edit.range.start.character,
            endLine: edit.range.end.line + 1,
            endCol: edit.range.end.character,
            text: edit.newText,
          };
        }),
      }));
    } catch {
      return [];
    }
  }

  /** Request document formatting. */
  async requestFormatting(
    languageId: string,
    path: string,
  ): Promise<Array<{ line: number; col: number; endLine: number; endCol: number; text: string }>> {
    if (!supportsLspLanguage(languageId)) return [];
    const conn = await this.ensureConnection(languageId);
    try {
      const result = await conn.request('textDocument/formatting', {
        textDocument: { uri: `file://${path}` },
        options: { tabSize: 2, insertSpaces: true },
      });
      const edits = (result || []) as unknown[];
      return edits.map((e) => {
        const edit = e as { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string };
        return {
          line: edit.range.start.line + 1,
          col: edit.range.start.character,
          endLine: edit.range.end.line + 1,
          endCol: edit.range.end.character,
          text: edit.newText,
        };
      });
    } catch {
      return [];
    }
  }

  /** Subscribe to diagnostic updates. */
  onDiagnostics(callback: (path: string, diagnostics: Diagnostic[]) => void): () => void {
    this.diagnosticHandlers.add(callback);
    return () => { this.diagnosticHandlers.delete(callback); };
  }

  /** Check LSP server health (§4: "Expose language-server health"). */
  async healthCheck(languageId: string): Promise<LspHealth> {
    return this.gateway.lspHealth(languageId);
  }

  /** Restart a language server (§4: "restart controls"). */
  async restart(languageId: string): Promise<void> {
    const key = connectionKey(languageId);
    const conn = this.connections.get(key);
    if (conn) {
      conn.disconnect();
      this.connections.delete(key);
    }
    await this.gateway.lspRestart(languageId);
  }

  /** List available LSP servers. */
  async servers(): Promise<LspServerInfo[]> {
    return this.gateway.lspServers();
  }

  /** Disconnect all LSP connections. */
  dispose(): void {
    for (const conn of this.connections.values()) {
      conn.disconnect();
    }
    this.connections.clear();
    this.initialized.clear();
    this.versions.clear();
    this.diagnosticHandlers.clear();
  }
}

function connectionKey(languageId: string): string {
  return ['typescript', 'javascript', 'javascriptreact', 'typescriptreact'].includes(languageId) ? 'typescript' : languageId;
}
