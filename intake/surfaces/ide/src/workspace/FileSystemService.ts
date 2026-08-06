// CURSE'M IDE — Filesystem Service (§2, §9).
//
// §2: "The canonical workspace must be the actual filesystem."
// §2: "Support filesystem watching and externally changed files."
// §2: "Detect conflicts when an agent or terminal modifies an open file."
// §2: "Browser storage may only hold UI preferences, cached indexes,
//       and recoverable unsaved buffers."
//
// Wraps the HostGateway's filesystem methods with:
//   - Path validation (§9: path traversal + workspace containment)
//   - File watching for external changes
//   - Conflict detection (editor vs. disk)
//   - Buffer recovery (localStorage — NOT authoritative FS)

import type { HostGateway, DirEntry, FileStat, BinaryFile, FileWatchEvent } from '@/platform';
import { validateWorkspacePath } from './pathSecurity';

export interface ConflictResult {
  hasConflict: boolean;
  diskContent: string;
  editorContent: string;
  /** Disk changed since last known, but editor has no unsaved changes — just reload. */
  shouldReload: boolean;
}

export interface WorkspaceSearchResult {
  path: string;
  line: number;
  column: number;
  preview: string;
}

const SKIPPED_DIRECTORIES = new Set([
  '.git', '.cache', '.next', '.nuxt', '.output', '.planning', '.turbo', '.vite',
  'node_modules', 'dist', 'build', 'coverage', 'out', 'target', 'artifacts',
  'runtime', 'tmp', 'test-results', 'playwright-report', 'dogfood-output',
  'smoke-output', '.floyd',
]);
const GENERATED_SEARCH_FILE = /(?:^|[-_.])smoke(?:[-_.].*)?\.json$/i;
const MAX_SEARCH_FILE_BYTES = 16 * 1024 * 1024;

export class FileSystemService {
  private gateway: HostGateway;
  private workspaceRoot: string;
  /** Tracks last-known disk content for open files (for conflict detection). */
  private openFiles = new Map<string, string>();
  private watcherUnsub: (() => void) | null = null;
  private watchCallbacks = new Set<(event: FileWatchEvent) => void>();

  constructor(gateway: HostGateway, workspaceRoot: string) {
    this.gateway = gateway;
    this.workspaceRoot = workspaceRoot;
  }

  /** Validate a path against the workspace root. Throws on violation. */
  private validate(path: string): string {
    const result = validateWorkspacePath(path, this.workspaceRoot);
    if (!result.valid) {
      throw new Error(result.reason || 'Path validation failed');
    }
    return result.resolved;
  }

  // ── File operations ─────────────────────────────────────────────────

  async readFile(path: string): Promise<string> {
    const resolved = this.validate(path);
    const content = await this.gateway.readFile(resolved);
    this.openFiles.set(resolved, content);
    return content;
  }

  /** Raw bytes for document viewers (images, PDF, DOCX). Not tracked as an
   *  open text file — viewers never participate in conflict detection. */
  async readBinary(path: string): Promise<BinaryFile> {
    const resolved = this.validate(path);
    return this.gateway.readFileBinary(resolved);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const resolved = this.validate(path);
    await this.gateway.writeFile(resolved, content);
    this.openFiles.set(resolved, content);
    this.clearBuffer(resolved);
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const resolved = this.validate(path);
    return this.gateway.listDir(resolved);
  }

  async stat(path: string): Promise<FileStat> {
    const resolved = this.validate(path);
    return this.gateway.stat(resolved);
  }

  async mkdir(path: string): Promise<void> {
    const resolved = this.validate(path);
    await this.gateway.mkdir(resolved);
  }

  async rename(from: string, to: string): Promise<void> {
    const resolvedFrom = this.validate(from);
    const resolvedTo = this.validate(to);
    await this.gateway.rename(resolvedFrom, resolvedTo);
  }

  async remove(path: string): Promise<void> {
    const resolved = this.validate(path);
    await this.gateway.remove(resolved);
    this.openFiles.delete(resolved);
    this.clearBuffer(resolved);
  }

  /** Recursively list workspace files while excluding generated/vendor trees. */
  async walkFiles(limit = 2500): Promise<DirEntry[]> {
    const files: DirEntry[] = [];
    const queue = [this.workspaceRoot];
    while (queue.length > 0 && files.length < limit) {
      const directory = queue.shift();
      if (!directory) break;
      const entries = await this.listDir(directory);
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.type === 'dir' && !SKIPPED_DIRECTORIES.has(entry.name)) queue.push(entry.path);
        if (entry.type === 'file' && !GENERATED_SEARCH_FILE.test(entry.name)) files.push(entry);
        if (files.length >= limit) break;
      }
    }
    return files;
  }

  /** Search file names and UTF-8 text content through the trusted host gateway. */
  async searchWorkspace(query: string, limit = 200): Promise<WorkspaceSearchResult[]> {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    const results: WorkspaceSearchResult[] = [];
    const files = await this.walkFiles();
    for (const file of files) {
      if (results.length >= limit) break;
      if (file.name.toLocaleLowerCase().includes(needle)) {
        results.push({ path: file.path, line: 1, column: 1, preview: 'File name match' });
      }
      if (file.size > MAX_SEARCH_FILE_BYTES || results.length >= limit) continue;
      try {
        const content = await this.readFile(file.path);
        if (content.includes('\0')) continue;
        const lines = content.split('\n');
        for (let index = 0; index < lines.length && results.length < limit; index++) {
          const column = lines[index].toLocaleLowerCase().indexOf(needle);
          if (column >= 0) {
            results.push({
              path: file.path,
              line: index + 1,
              column: column + 1,
              preview: lines[index].trim().slice(0, 180),
            });
          }
        }
      } catch {
        // Binary, unreadable, and transient files do not abort the search.
      }
    }
    return results;
  }

  // ── File watching (§2) ──────────────────────────────────────────────

  /** Start watching the workspace root for external changes. */
  startWatching(): void {
    if (this.watcherUnsub) return;
    this.watcherUnsub = this.gateway.watch(this.workspaceRoot, (event) => {
      for (const cb of this.watchCallbacks) {
        try { cb(event); } catch (e) { console.error('[fs] watch callback error:', e); }
      }
    });
  }

  stopWatching(): void {
    if (this.watcherUnsub) {
      this.watcherUnsub();
      this.watcherUnsub = null;
    }
  }

  onFileChange(callback: (event: FileWatchEvent) => void): () => void {
    this.watchCallbacks.add(callback);
    return () => { this.watchCallbacks.delete(callback); };
  }

  // ── Conflict detection (§2) ─────────────────────────────────────────

  /** Register an open file with its disk content. */
  registerOpenFile(path: string, diskContent: string): void {
    this.openFiles.set(path, diskContent);
  }

  /** Unregister a closed file. */
  unregisterOpenFile(path: string): void {
    this.openFiles.delete(path);
  }

  /**
   * Check for conflicts when an external change is detected.
   * Returns conflict info if the disk changed while the editor has unsaved changes.
   */
  async checkConflict(path: string, editorContent: string): Promise<ConflictResult> {
    const resolved = this.validate(path);
    const diskContent = await this.gateway.readFile(resolved);
    const lastKnown = this.openFiles.get(resolved);

    const diskChanged = lastKnown !== undefined && diskContent !== lastKnown;
    const editorChanged = diskContent !== editorContent;

    this.openFiles.set(resolved, diskContent);

    return {
      hasConflict: diskChanged && editorChanged,
      shouldReload: diskChanged && !editorChanged,
      diskContent,
      editorContent,
    };
  }

  // ── Buffer recovery (§3: "recovery of unsaved buffers") ─────────────
  // §2: "Browser storage may only hold UI preferences, cached indexes,
  //       and recoverable unsaved buffers."

  saveBuffer(path: string, content: string): void {
    try {
      localStorage.setItem(`cursem:buffer:${path}`, content);
    } catch (e) {
      console.error('[fs] Failed to save buffer:', e);
    }
  }

  recoverBuffer(path: string): string | null {
    try {
      return localStorage.getItem(`cursem:buffer:${path}`);
    } catch {
      return null;
    }
  }

  clearBuffer(path: string): void {
    try {
      localStorage.removeItem(`cursem:buffer:${path}`);
    } catch { /* ignore */ }
  }

  /** Get all recoverable buffers (for session restore). */
  getAllBuffers(): Array<{ path: string; content: string }> {
    const buffers: Array<{ path: string; content: string }> = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('cursem:buffer:')) {
          const path = key.slice('cursem:buffer:'.length);
          const content = localStorage.getItem(key);
          if (content !== null) buffers.push({ path, content });
        }
      }
    } catch { /* ignore */ }
    return buffers;
  }
}
