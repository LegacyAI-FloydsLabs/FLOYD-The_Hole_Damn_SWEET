// CURSE'M IDE — Host Gateway Abstraction (§8, §9).
//
// The HostGateway is the single interface through which the IDE
// communicates with its trusted loopback backend. It handles:
//
//   - Platform state (auth, workspace, OpenCode instance, agent, theme)
//   - Filesystem operations (§2 — confined to approved workspace roots, §9)
//   - Git operations (§7 — real system Git through Floyd backend)
//   - LSP gateway (§4 — platform-managed language servers)
//   - TerminalOne authorization (§6 — auth from Floyd platform gateway)
//   - Debug adapter control (§10 — debug adapters in trusted backend)
//   - Permissions and destructive-op confirmation (§9)
//   - Notifications (§8)
//   - Event emission (§8)
//
// §9: "Separate frontend rendering from privileged host operations."
// The HostGateway IS that separation — the frontend never touches the
// filesystem, Git, LSP, or terminal directly. Everything goes through here.

import type {
  AuthSession,
  Workspace,
  OpenCodeInstance,
  AgentConfig,
  AgentThread,
  AgentMessage,
  AgentRun,
  AgentRunStatus,
  AgentRunEvent,
  AgentPatchChange,
  AgentPatchFile,
  AgentPatchPreview,
  AgentCheckpoint,
  ContextIndexStatus,
  ContextSearchResult,
  ContextSelector,
  ResolvedContext,
  AgentRuleSet,
  AgentMemory,
  AgentTaskRequest,
  AgentTaskResult,
  McpServerInfo,
  McpTool,
  MigrationPreview,
  WorkspaceTask,
  Theme,
  PlatformNotification,
  DirEntry,
  FileStat,
  FileWatchEvent,
  GitStatus,
  GitCommit,
  GitBranch,
  LspHealth,
  LspServerInfo,
  TerminalAuth,
  DebugConfig,
  DebugSession,
  DebugCommand,
  DebugVariable,
  DebugStackFrame,
  HostEvent,
  PlatformConfig,
} from './types';

import { PlatformEventBus } from './events';

// ─── Host Gateway Interface ───────────────────────────────────────────

export interface HostGateway {
  readonly eventBus: PlatformEventBus;
  readonly config: PlatformConfig;

  // Platform state (§8)
  getAuthSession(): Promise<AuthSession | null>;
  getWorkspace(): Promise<Workspace | null>;
  /** Ask the trusted host to show its native folder picker and authorize a workspace root. */
  selectWorkspace?(): Promise<Workspace | null>;
  getOpenCodeInstance(): Promise<OpenCodeInstance | null>;
  getActiveAgent(): Promise<AgentConfig | null>;
  getTheme(): Promise<Theme | null>;

  // Durable Agent state and transactional edits
  agentListThreads(): Promise<AgentThread[]>;
  agentCreateThread(title: string): Promise<AgentThread>;
  agentGetThread(id: string): Promise<AgentThread>;
  agentAddMessage(threadId: string, role: AgentMessage['role'], content: string, metadata?: Record<string, unknown>): Promise<AgentMessage>;
  agentCreateRun(threadId: string, provider: string, model: string): Promise<AgentRun>;
  agentGetRun(id: string): Promise<AgentRun>;
  agentUpdateRun(runId: string, status: AgentRunStatus, summary?: Record<string, unknown>): Promise<AgentRun>;
  agentAppendEvent(runId: string, type: string, payload?: Record<string, unknown>): Promise<AgentRunEvent>;
  agentPreviewPatch(changes: AgentPatchChange[], runId?: string): Promise<AgentPatchPreview>;
  agentApplyPatch(proposalId: string, acceptedPaths?: string[], label?: string, acceptedHunks?: Record<string, string[]>): Promise<{ checkpointId: string; files: AgentPatchFile[] }>;
  agentListCheckpoints(): Promise<AgentCheckpoint[]>;
  agentRestoreCheckpoint(checkpointId: string): Promise<{ restored: string; files: AgentPatchFile[] }>;
  contextStatus(): Promise<ContextIndexStatus>;
  contextRefresh(): Promise<ContextIndexStatus>;
  contextSearch(query: string, limit?: number): Promise<ContextSearchResult[]>;
  contextResolve(selectors: ContextSelector[], budgetChars?: number): Promise<ResolvedContext>;
  contextRules(path?: string): Promise<AgentRuleSet>;
  agentListMemories(): Promise<AgentMemory[]>;
  agentSaveMemory(content: string): Promise<AgentMemory>;
  agentDeleteMemory(id: string): Promise<void>;
  agentRunTask(request: AgentTaskRequest, signal?: AbortSignal): Promise<AgentTaskResult>;
  mcpListServers(): Promise<McpServerInfo[]>;
  mcpConnect(id: string): Promise<McpServerInfo>;
  mcpDisconnect(id: string): Promise<void>;
  mcpListTools(id: string): Promise<McpTool[]>;
  mcpCallTool(id: string, name: string, args: Record<string, unknown>): Promise<unknown>;
  migrationPreview(source: 'cursor' | 'vscode'): Promise<MigrationPreview>;
  taskList(): Promise<WorkspaceTask[]>;
  taskRun(task: WorkspaceTask, signal?: AbortSignal): Promise<AgentTaskResult>;

  // Filesystem (§2, §9)
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<FileStat>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Watch a path for external changes (§2: "Support filesystem watching"). */
  watch(path: string, callback: (event: FileWatchEvent) => void): () => void;

  // Git (§7)
  gitStatus(repoPath: string): Promise<GitStatus>;
  gitStage(repoPath: string, files: string[]): Promise<void>;
  gitUnstage(repoPath: string, files: string[]): Promise<void>;
  gitCommit(repoPath: string, message: string): Promise<void>;
  gitFetch(repoPath: string): Promise<void>;
  gitPull(repoPath: string): Promise<void>;
  gitPush(repoPath: string): Promise<void>;
  gitBranch(repoPath: string, name: string): Promise<void>;
  gitCheckout(repoPath: string, branch: string): Promise<void>;
  gitDiff(repoPath: string, file?: string): Promise<string>;
  gitLog(repoPath: string, limit?: number): Promise<GitCommit[]>;
  gitBranches(repoPath: string): Promise<GitBranch[]>;

  // LSP (§4)
  lspConnect(languageId: string): Promise<LspConnection>;
  lspHealth(languageId: string): Promise<LspHealth>;
  lspRestart(languageId: string): Promise<void>;
  lspServers(): Promise<LspServerInfo[]>;

  // Terminal (§6)
  /** Get authorization for TerminalOne — from Floyd platform gateway (§6). */
  terminalAuth(): Promise<TerminalAuth>;

  // Debug (§10)
  debugLaunch(config: DebugConfig): Promise<DebugSession>;
  debugControl(sessionId: string, command: DebugCommand): Promise<void>;
  debugGetVariables(sessionId: string, variablesReference?: number): Promise<DebugVariable[]>;
  debugGetStackFrames(sessionId: string): Promise<DebugStackFrame[]>;

  // Permissions & confirmation (§9)
  requestPermission(resource: string, action: string): Promise<boolean>;
  /** §9: "Require confirmation for destructive filesystem and Git operations." */
  confirmDestructive(operation: string, details: string): Promise<boolean>;

  // Notifications (§8)
  notify(notification: Omit<PlatformNotification, 'id' | 'timestamp'>): void;

  // Events (§8)
  emit(event: HostEvent): void;
}

// ─── LSP Connection (§4) ──────────────────────────────────────────────

export interface LspConnection {
  languageId: string;
  /** Send a request and await response. */
  request(method: string, params: unknown): Promise<unknown>;
  /** Send a notification (no response expected). */
  notify(method: string, params: unknown): void;
  /** Subscribe to server-pushed notifications (diagnostics, etc.). */
  onNotification(method: string, handler: (params: unknown) => void): () => void;
  /** Close the connection. */
  disconnect(): void;
}

// ─── HTTP Host Gateway (dev mode) ─────────────────────────────────────
//
// Talks to a Floyd-compatible HTTP backend. Used in standalone dev mode.
// In production, Floyd Desktop provides its own HostGateway implementation
// (likely PostMessageHostGateway for iframe embedding).

export class HttpHostGateway implements HostGateway {
  readonly eventBus: PlatformEventBus;
  readonly config: PlatformConfig;
  private watchers = new Map<string, () => void>();
  private activeWorkspace: Workspace | null = null;

  constructor(config: PlatformConfig) {
    this.config = config;
    this.eventBus = new PlatformEventBus();
  }

  private get baseUrl(): string {
    return this.config.gatewayUrl;
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.authToken) {
      h['Authorization'] = `Bearer ${this.config.authToken}`;
    }
    return h;
  }

  private readonly defaultTimeoutMs = 30000;

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.defaultTimeoutMs);

    if (init?.signal) {
      init.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: { ...this.headers, ...(init?.headers || {}) },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`API ${path} failed: ${res.status} ${text}`);
      }
      return res.json() as Promise<T>;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── Platform state ──────────────────────────────────────────────────

  async getAuthSession(): Promise<AuthSession | null> {
    return this.api<AuthSession | null>('/api/platform/auth').catch(() => null);
  }

  async getWorkspace(): Promise<Workspace | null> {
    if (this.activeWorkspace) return this.activeWorkspace;
    try {
      this.activeWorkspace = await this.api<Workspace>('/api/platform/workspace');
      return this.activeWorkspace;
    } catch {
      if (!this.config.workspaceRoot) return null;
      return {
        id: this.config.workspaceId,
        root: this.config.workspaceRoot,
        project: { id: this.config.workspaceId, name: this.config.workspaceRoot.split('/').pop() || 'workspace' },
        repositories: [],
      };
    }
  }

  async selectWorkspace(): Promise<Workspace | null> {
    const response = await this.api<{ workspace?: unknown }>('/api/platform/workspace/select', {
      method: 'POST',
    });
    const workspace = response.workspace;
    if (workspace == null) return null;
    if (
      typeof workspace !== 'object'
      || typeof (workspace as Workspace).id !== 'string'
      || typeof (workspace as Workspace).root !== 'string'
      || !(workspace as Workspace).root.trim()
      || typeof (workspace as Workspace).project !== 'object'
      || (workspace as Workspace).project === null
      || typeof (workspace as Workspace).project.id !== 'string'
      || typeof (workspace as Workspace).project.name !== 'string'
      || !Array.isArray((workspace as Workspace).repositories)
    ) {
      throw new Error('The CURSEM host returned an invalid workspace selection.');
    }
    this.activeWorkspace = workspace as Workspace;
    return this.activeWorkspace;
  }

  async getOpenCodeInstance(): Promise<OpenCodeInstance | null> {
    if (!this.config.opencodeUrl) return null;
    return {
      id: 'default',
      url: this.config.opencodeUrl,
      status: 'running',
    };
  }

  async getActiveAgent(): Promise<AgentConfig | null> {
    return this.api<AgentConfig | null>('/api/platform/agent').catch(() => null);
  }

  async getTheme(): Promise<Theme | null> {
    return this.api<Theme | null>('/api/platform/theme').catch(() => null);
  }

  async agentListThreads(): Promise<AgentThread[]> {
    return (await this.api<{ threads: AgentThread[] }>('/api/agent/threads')).threads;
  }

  async agentCreateThread(title: string): Promise<AgentThread> {
    return this.api<AgentThread>('/api/agent/threads', { method: 'POST', body: JSON.stringify({ title }) });
  }

  async agentGetThread(id: string): Promise<AgentThread> {
    return this.api<AgentThread>(`/api/agent/thread?id=${encodeURIComponent(id)}`);
  }

  async agentAddMessage(threadId: string, role: AgentMessage['role'], content: string, metadata: Record<string, unknown> = {}): Promise<AgentMessage> {
    return this.api<AgentMessage>('/api/agent/messages', { method: 'POST', body: JSON.stringify({ threadId, role, content, metadata }) });
  }

  async agentCreateRun(threadId: string, provider: string, model: string): Promise<AgentRun> {
    return this.api<AgentRun>('/api/agent/runs', { method: 'POST', body: JSON.stringify({ threadId, provider, model }) });
  }

  async agentGetRun(id: string): Promise<AgentRun> {
    return this.api<AgentRun>(`/api/agent/run?id=${encodeURIComponent(id)}`);
  }

  async agentUpdateRun(runId: string, status: AgentRunStatus, summary: Record<string, unknown> = {}): Promise<AgentRun> {
    return this.api<AgentRun>('/api/agent/run/update', { method: 'POST', body: JSON.stringify({ runId, status, summary }) });
  }

  async agentAppendEvent(runId: string, type: string, payload: Record<string, unknown> = {}): Promise<AgentRunEvent> {
    return this.api<AgentRunEvent>('/api/agent/events', { method: 'POST', body: JSON.stringify({ runId, type, payload }) });
  }

  async agentPreviewPatch(changes: AgentPatchChange[], runId?: string): Promise<AgentPatchPreview> {
    return this.api<AgentPatchPreview>('/api/agent/patch/preview', { method: 'POST', body: JSON.stringify({ changes, runId }) });
  }

  async agentApplyPatch(proposalId: string, acceptedPaths?: string[], label?: string, acceptedHunks?: Record<string, string[]>): Promise<{ checkpointId: string; files: AgentPatchFile[] }> {
    return this.api('/api/agent/patch/apply', { method: 'POST', body: JSON.stringify({ proposalId, acceptedPaths, label, acceptedHunks }) });
  }

  async agentListCheckpoints(): Promise<AgentCheckpoint[]> {
    return (await this.api<{ checkpoints: AgentCheckpoint[] }>('/api/agent/checkpoints')).checkpoints;
  }

  async agentRestoreCheckpoint(checkpointId: string): Promise<{ restored: string; files: AgentPatchFile[] }> {
    return this.api('/api/agent/checkpoints/restore', { method: 'POST', body: JSON.stringify({ checkpointId }) });
  }

  async contextStatus(): Promise<ContextIndexStatus> { return this.api('/api/context/status'); }
  async contextRefresh(): Promise<ContextIndexStatus> { return this.api('/api/context/refresh', { method: 'POST' }); }
  async contextSearch(query: string, limit = 20): Promise<ContextSearchResult[]> {
    return (await this.api<{ results: ContextSearchResult[] }>('/api/context/search', { method: 'POST', body: JSON.stringify({ query, limit }) })).results;
  }
  async contextResolve(selectors: ContextSelector[], budgetChars?: number): Promise<ResolvedContext> {
    return this.api('/api/context/resolve', { method: 'POST', body: JSON.stringify({ selectors, budgetChars }) });
  }
  async contextRules(path = ''): Promise<AgentRuleSet> { return this.api(`/api/context/rules?path=${encodeURIComponent(path)}`); }
  async agentListMemories(): Promise<AgentMemory[]> { return (await this.api<{ memories: AgentMemory[] }>('/api/agent/memories')).memories; }
  async agentSaveMemory(content: string): Promise<AgentMemory> { return this.api('/api/agent/memories', { method: 'POST', body: JSON.stringify({ content }) }); }
  async agentDeleteMemory(id: string): Promise<void> { await this.api(`/api/agent/memories?id=${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  async agentRunTask(request: AgentTaskRequest, signal?: AbortSignal): Promise<AgentTaskResult> {
    const command = [request.executable, ...request.args].join(' ');
    if (!(await this.confirmDestructive('run Agent task', `${command}\n\ncwd: ${request.cwd || this.config.workspaceRoot}`))) throw new Error('Agent task was not approved.');
    return this.api('/api/agent/task', { method: 'POST', body: JSON.stringify(request), signal });
  }
  async mcpListServers(): Promise<McpServerInfo[]> { return (await this.api<{ servers: McpServerInfo[] }>('/api/mcp/servers')).servers; }
  async mcpConnect(id: string): Promise<McpServerInfo> {
    if (!(await this.confirmDestructive('connect MCP server', id))) throw new Error('MCP connection was not approved.');
    return this.api('/api/mcp/connect', { method: 'POST', body: JSON.stringify({ id }) });
  }
  async mcpDisconnect(id: string): Promise<void> { await this.api('/api/mcp/disconnect', { method: 'POST', body: JSON.stringify({ id }) }); }
  async mcpListTools(id: string): Promise<McpTool[]> { return (await this.api<{ tools: McpTool[] }>(`/api/mcp/tools?id=${encodeURIComponent(id)}`)).tools; }
  async mcpCallTool(id: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!(await this.confirmDestructive('run MCP tool', `${id}.${name}\n${JSON.stringify(args, null, 2)}`))) throw new Error('MCP tool call was not approved.');
    return this.api('/api/mcp/call', { method: 'POST', body: JSON.stringify({ id, name, arguments: args }) });
  }
  async migrationPreview(source: 'cursor' | 'vscode'): Promise<MigrationPreview> {
    return this.api(`/api/migration/preview?source=${source}`);
  }
  async taskList(): Promise<WorkspaceTask[]> { return (await this.api<{ tasks: WorkspaceTask[] }>('/api/tasks')).tasks; }
  async taskRun(task: WorkspaceTask, signal?: AbortSignal): Promise<AgentTaskResult> {
    const command = [task.executable, ...task.args].join(' ');
    if (!(await this.confirmDestructive(`run workspace ${task.kind}`, `${command}\n\nsource: ${task.source}`))) throw new Error('Workspace task was not approved.');
    return this.api('/api/agent/task', { method: 'POST', body: JSON.stringify({ executable: task.executable, args: task.args }), signal });
  }

  // ── Filesystem ──────────────────────────────────────────────────────

  async readFile(path: string): Promise<string> {
    const r = await this.api<{ content: string }>(`/api/fs/read?path=${encodeURIComponent(path)}`);
    return r.content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.api('/api/fs/write', {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    });
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const r = await this.api<{ items: DirEntry[] }>(`/api/fs/list?path=${encodeURIComponent(path)}`);
    return r.items;
  }

  async stat(path: string): Promise<FileStat> {
    return this.api<FileStat>(`/api/fs/stat?path=${encodeURIComponent(path)}`);
  }

  async mkdir(path: string): Promise<void> {
    await this.api('/api/fs/mkdir', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  }

  async rename(from: string, to: string): Promise<void> {
    // §9: Require confirmation for destructive filesystem operations.
    const ok = await this.confirmDestructive('rename', `${from} → ${to}`);
    if (!ok) throw new Error('Rename cancelled by user');
    await this.api('/api/fs/rename', {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    });
  }

  async remove(path: string): Promise<void> {
    // §9: Require confirmation for destructive filesystem operations.
    const ok = await this.confirmDestructive('delete', path);
    if (!ok) throw new Error('Delete cancelled by user');
    await this.api(`/api/fs/remove?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    });
  }

  watch(path: string, callback: (event: FileWatchEvent) => void): () => void {
    // §2: "Support filesystem watching and externally changed files."
    // Uses SSE (Server-Sent Events) for real-time file change notifications.
    const url = `${this.baseUrl}/api/fs/watch?path=${encodeURIComponent(path)}`;
    const es = new EventSource(url);

    es.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data) as FileWatchEvent;
        callback(event);
      } catch {}
    };

    es.onerror = () => {
      // Reconnection is handled by EventSource automatically.
    };

    const unsubscribe = () => {
      es.close();
    };
    this.watchers.set(path, unsubscribe);
    return () => {
      unsubscribe();
      this.watchers.delete(path);
    };
  }

  // ── Git ─────────────────────────────────────────────────────────────

  async gitStatus(repoPath: string): Promise<GitStatus> {
    return this.api<GitStatus>(`/api/git/status?path=${encodeURIComponent(repoPath)}`);
  }

  async gitStage(repoPath: string, files: string[]): Promise<void> {
    await this.api('/api/git/stage', {
      method: 'POST',
      body: JSON.stringify({ repoPath, files }),
    });
  }

  async gitUnstage(repoPath: string, files: string[]): Promise<void> {
    await this.api('/api/git/unstage', {
      method: 'POST',
      body: JSON.stringify({ repoPath, files }),
    });
  }

  async gitCommit(repoPath: string, message: string): Promise<void> {
    await this.api('/api/git/commit', {
      method: 'POST',
      body: JSON.stringify({ repoPath, message }),
    });
  }

  async gitFetch(repoPath: string): Promise<void> {
    await this.api('/api/git/fetch', {
      method: 'POST',
      body: JSON.stringify({ repoPath }),
    });
  }

  async gitPull(repoPath: string): Promise<void> {
    await this.api('/api/git/pull', {
      method: 'POST',
      body: JSON.stringify({ repoPath }),
    });
  }

  async gitPush(repoPath: string): Promise<void> {
    // §7: "push with confirmation"
    const ok = await this.confirmDestructive('git push', repoPath);
    if (!ok) throw new Error('Push cancelled by user');
    await this.api('/api/git/push', {
      method: 'POST',
      body: JSON.stringify({ repoPath }),
    });
  }

  async gitBranch(repoPath: string, name: string): Promise<void> {
    await this.api('/api/git/branch', {
      method: 'POST',
      body: JSON.stringify({ repoPath, name }),
    });
  }

  async gitCheckout(repoPath: string, branch: string): Promise<void> {
    await this.api('/api/git/checkout', {
      method: 'POST',
      body: JSON.stringify({ repoPath, branch }),
    });
  }

  async gitDiff(repoPath: string, file?: string): Promise<string> {
    const params = new URLSearchParams({ path: repoPath });
    if (file) params.set('file', file);
    const r = await this.api<{ diff: string }>(`/api/git/diff?${params}`);
    return r.diff;
  }

  async gitLog(repoPath: string, limit?: number): Promise<GitCommit[]> {
    const params = new URLSearchParams({ path: repoPath });
    if (limit) params.set('limit', String(limit));
    const r = await this.api<{ commits: GitCommit[] }>(`/api/git/log?${params}`);
    return r.commits;
  }

  async gitBranches(repoPath: string): Promise<GitBranch[]> {
    const r = await this.api<{ branches: GitBranch[] }>(`/api/git/branches?path=${encodeURIComponent(repoPath)}`);
    return r.branches;
  }

  // ── LSP ─────────────────────────────────────────────────────────────

  async lspConnect(languageId: string): Promise<LspConnection> {
    // §4: "Connect to real language servers through a platform-managed LSP gateway."
    // §4: "Do not run separate duplicate language servers for every browser tab."
    // The gateway manages a single LSP connection per language; the IDE
    // gets a multiplexed view of it.
    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/ws/lsp/${languageId}`;
    return new WebSocketLspConnection(languageId, wsUrl, this.config.authToken);
  }

  async lspHealth(languageId: string): Promise<LspHealth> {
    return this.api<LspHealth>(`/api/lsp/health?language=${languageId}`);
  }

  async lspRestart(languageId: string): Promise<void> {
    await this.api('/api/lsp/restart', {
      method: 'POST',
      body: JSON.stringify({ languageId }),
    });
  }

  async lspServers(): Promise<LspServerInfo[]> {
    const r = await this.api<{ servers: LspServerInfo[] }>('/api/lsp/servers');
    return r.servers;
  }

  // ── Terminal ────────────────────────────────────────────────────────

  async terminalAuth(): Promise<TerminalAuth> {
    // Terminal authorization comes from the loopback host and is short lived.
    // §6: "The IDE must never expose an unauthenticated PTY to the network."
    return this.api<TerminalAuth>('/api/terminal/auth');
  }

  // ── Debug ───────────────────────────────────────────────────────────

  async debugLaunch(config: DebugConfig): Promise<DebugSession> {
    // §10: "Debug adapters run in the trusted backend, not inside browser JavaScript."
    return this.api<DebugSession>('/api/debug/launch', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  async debugControl(sessionId: string, command: DebugCommand): Promise<void> {
    await this.api('/api/debug/control', {
      method: 'POST',
      body: JSON.stringify({ sessionId, command }),
    });
  }

  async debugGetVariables(sessionId: string, variablesReference?: number): Promise<DebugVariable[]> {
    const params = new URLSearchParams({ sessionId });
    if (variablesReference) params.set('ref', String(variablesReference));
    const r = await this.api<{ variables: DebugVariable[] }>(`/api/debug/variables?${params}`);
    return r.variables;
  }

  async debugGetStackFrames(sessionId: string): Promise<DebugStackFrame[]> {
    const r = await this.api<{ frames: DebugStackFrame[] }>(`/api/debug/stack?sessionId=${sessionId}`);
    return r.frames;
  }

  // ── Permissions & confirmation ──────────────────────────────────────

  async requestPermission(resource: string, action: string): Promise<boolean> {
    try {
      const r = await this.api<{ granted: boolean }>('/api/platform/permission', {
        method: 'POST',
        body: JSON.stringify({ resource, action }),
      });
      return r.granted;
    } catch {
      return false;
    }
  }

  async confirmDestructive(operation: string, details: string): Promise<boolean> {
    // §9: "Require confirmation for destructive filesystem and Git operations."
    // In dev mode, use window.confirm. In production, Floyd provides a
    // custom confirmation UI via the gateway.
    if (typeof window !== 'undefined' && window.confirm) {
      return window.confirm(`${operation}: ${details}\n\nProceed?`);
    }
    return true;
  }

  // ── Notifications ───────────────────────────────────────────────────

  notify(notification: Omit<PlatformNotification, 'id' | 'timestamp'>): void {
    const full: PlatformNotification = {
      ...notification,
      id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    };
    // Emit as a platform event so UI can react.
    this.eventBus.emit({
      type: 'workspace.changed',
      workspaceId: this.config.workspaceId,
    });
    // Also store for polling (if needed).
    console.log('[notification]', full);
  }

  // ── Events ──────────────────────────────────────────────────────────

  emit(event: HostEvent): void {
    this.eventBus.emit(event);
  }
}

// ─── WebSocket LSP Connection (§4) ────────────────────────────────────

class WebSocketLspConnection implements LspConnection {
  readonly languageId: string;
  private ws: WebSocket;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private nextId = 1;
  private closed = false;
  private readonly ready: Promise<void>;

  constructor(languageId: string, wsUrl: string, authToken?: string) {
    this.languageId = languageId;

    const protocols = authToken ? [authToken] : undefined;
    this.ws = new WebSocket(wsUrl, protocols);
    this.ready = new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.addEventListener('error', () => reject(new Error('Language server connection failed.')), { once: true });
    });

    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || 'LSP error'));
          else resolve(msg.result);
        } else if (msg.method) {
          // Server-pushed notification
          const handlers = this.notificationHandlers.get(msg.method);
          if (handlers) {
            for (const h of handlers) {
              try { h(msg.params); } catch {}
            }
          }
        }
      } catch {}
    };

    this.ws.onerror = () => {
      // Reject all pending requests on error.
      for (const [, { reject }] of this.pending) {
        reject(new Error('WebSocket error'));
      }
      this.pending.clear();
    };

    this.ws.onclose = () => {
      for (const [, { reject }] of this.pending) {
        reject(new Error('Connection closed'));
      }
      this.pending.clear();
    };
  }

  async request(method: string, params: unknown): Promise<unknown> {
    await this.ready;
    return new Promise((resolve, reject) => {
      if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Connection not open'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  notify(method: string, params: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
    }
  }

  onNotification(method: string, handler: (params: unknown) => void): () => void {
    let set = this.notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.notificationHandlers.delete(method);
    };
  }

  disconnect(): void {
    this.closed = true;
    this.ws.close();
  }
}

// ─── Mock Host Gateway (for tests) ────────────────────────────────────

export class MockHostGateway implements HostGateway {
  readonly eventBus: PlatformEventBus;
  readonly config: PlatformConfig;
  private files = new Map<string, string>();
  private confirmResult = true;
  private selectedWorkspace: Workspace | null = null;

  constructor(config?: Partial<PlatformConfig>) {
    this.config = {
      workspaceId: 'test-ws',
      workspaceRoot: '/test/workspace',
      gatewayUrl: 'http://localhost',
      opencodeUrl: 'http://localhost:4096',
      basePath: '/ide/',
      ...config,
    };
    this.eventBus = new PlatformEventBus();
  }

  setConfirmResult(result: boolean): void {
    this.confirmResult = result;
  }

  setFile(path: string, content: string): void {
    this.files.set(path, content);
  }

  setSelectedWorkspace(root: string, id = 'selected-workspace'): void {
    this.selectedWorkspace = {
      id,
      root,
      project: { id, name: root.split('/').filter(Boolean).pop() || 'workspace' },
      repositories: [],
    };
  }

  async getAuthSession() { return null; }
  async getWorkspace() {
    return {
      id: this.config.workspaceId,
      root: this.config.workspaceRoot,
      project: { id: 'test', name: 'test' },
      repositories: [],
    };
  }
  async selectWorkspace() { return this.selectedWorkspace; }
  async getOpenCodeInstance() {
    return { id: 'default', url: this.config.opencodeUrl, status: 'running' as const };
  }
  async getActiveAgent() { return null; }
  async getTheme() { return null; }
  async agentListThreads() { return []; }
  async agentCreateThread(title: string) { return { id: 'thread-1', title, createdAt: Date.now(), updatedAt: Date.now() }; }
  async agentGetThread(id: string) { return { id, title: 'Test', createdAt: Date.now(), updatedAt: Date.now(), messages: [], runs: [] }; }
  async agentAddMessage(threadId: string, role: AgentMessage['role'], content: string, metadata = {}) { return { id: 'message-1', threadId, role, content, metadata, createdAt: Date.now() }; }
  async agentCreateRun(threadId: string, provider: string, model: string) { return { id: 'run-1', threadId, status: 'running' as const, provider, model, startedAt: Date.now(), updatedAt: Date.now(), summary: {} }; }
  async agentGetRun(id: string) { return { id, threadId: 'thread-1', status: 'completed' as const, provider: 'test', model: 'test', startedAt: 0, updatedAt: 0, summary: {}, events: [] }; }
  async agentUpdateRun(runId: string, status: AgentRunStatus, summary = {}) { return { id: runId, threadId: 'thread-1', status, provider: 'test', model: 'test', startedAt: 0, updatedAt: Date.now(), summary }; }
  async agentAppendEvent(runId: string, type: string, payload = {}) { return { id: 'event-1', runId, sequence: 1, type, payload, createdAt: Date.now() }; }
  async agentPreviewPatch(changes: AgentPatchChange[]) { return { proposalId: 'proposal-1', expiresAt: Date.now() + 60_000, files: changes.map((change) => ({ path: change.path, operation: change.content === null ? 'delete' as const : 'modify' as const, beforeHash: null, afterHash: null, stats: { oldLines: 0, newLines: 0, delta: 0 }, hunks: [] })) }; }
  async agentApplyPatch(_proposalId: string, acceptedPaths?: string[]) { return { checkpointId: 'checkpoint-1', files: (acceptedPaths || []).map((path) => ({ path, operation: 'modify' as const, beforeHash: null, afterHash: null, stats: { oldLines: 0, newLines: 0, delta: 0 }, hunks: [] })) }; }
  async agentListCheckpoints() { return []; }
  async agentRestoreCheckpoint(checkpointId: string) { return { restored: checkpointId, files: [] }; }
  async contextStatus() { return { root: this.config.workspaceRoot, files: this.files.size, bytes: 0, indexedAt: Date.now(), dirty: false, indexing: false }; }
  async contextRefresh() { return this.contextStatus(); }
  async contextSearch() { return []; }
  async contextResolve() { return { items: [], totalChars: 0, budgetChars: 64 * 1024 }; }
  async contextRules() { return { applied: [], available: [] }; }
  async agentListMemories() { return []; }
  async agentSaveMemory(content: string) { return { id: 'memory-1', content, source: 'user-approved', createdAt: Date.now(), updatedAt: Date.now() }; }
  async agentDeleteMemory() {}
  async agentRunTask(request: AgentTaskRequest) { return { ...request, cwd: request.cwd || this.config.workspaceRoot, stdout: '', stderr: '', exitCode: 0, signal: null, durationMs: 0 }; }
  async mcpListServers() { return []; }
  async mcpConnect(id: string) { return { id, scope: 'project' as const, transport: 'stdio' as const, source: 'test', envKeys: [], status: 'connected' as const }; }
  async mcpDisconnect() {}
  async mcpListTools() { return []; }
  async mcpCallTool() { return {}; }
  async migrationPreview(source: 'cursor' | 'vscode') { return { source, label: source, found: false, sourcePaths: { settings: null, keybindings: null }, preferences: {}, importedKeys: [], keybindings: { count: 0, status: 'unsupported' as const, reason: '' }, snippets: { count: 0, names: [], status: 'unsupported' as const, reason: '' }, extensions: [] }; }
  async taskList() { return []; }
  async taskRun(task: WorkspaceTask) { return { executable: task.executable, args: task.args, cwd: this.config.workspaceRoot, stdout: '', stderr: '', exitCode: 0, signal: null, durationMs: 0 }; }

  async readFile(path: string) { return this.files.get(path) ?? ''; }
  async writeFile(path: string, content: string) { this.files.set(path, content); }
  async listDir(path: string) {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const entries = new Map<string, DirEntry>();
    for (const [filePath, content] of this.files) {
      if (!filePath.startsWith(prefix)) continue;
      const remainder = filePath.slice(prefix.length);
      if (!remainder) continue;
      const [name, ...rest] = remainder.split('/');
      const entryPath = `${prefix}${name}`;
      entries.set(name, rest.length > 0
        ? { name, path: entryPath, type: 'dir', size: 0, mtimeMs: 0 }
        : { name, path: filePath, type: 'file', size: content.length, mtimeMs: 0 });
    }
    return Array.from(entries.values());
  }
  async stat(path: string) {
    const content = this.files.get(path);
    if (content !== undefined) return { path, type: 'file' as const, size: content.length, mtimeMs: 0 };
    const prefix = path.endsWith('/') ? path : `${path}/`;
    if (Array.from(this.files.keys()).some((filePath) => filePath.startsWith(prefix))) {
      return { path, type: 'dir' as const, size: 0, mtimeMs: 0 };
    }
    throw new Error(`ENOENT: ${path}`);
  }
  async mkdir() {}
  async rename(from: string, to: string) {
    const moves = Array.from(this.files.entries()).filter(([path]) => path === from || path.startsWith(`${from}/`));
    for (const [path, content] of moves) {
      this.files.delete(path);
      this.files.set(`${to}${path.slice(from.length)}`, content);
    }
  }
  async remove(path: string) {
    for (const filePath of Array.from(this.files.keys())) {
      if (filePath === path || filePath.startsWith(`${path}/`)) this.files.delete(filePath);
    }
  }
  watch() { return () => {}; }

  async gitStatus() {
    return {
      repoPath: '', branch: 'main', upstream: null,
      ahead: 0, behind: 0, clean: true, prooflineGoverned: false, changedFiles: [], lastCommit: null,
    };
  }
  async gitStage() {}
  async gitUnstage() {}
  async gitCommit() {}
  async gitFetch() {}
  async gitPull() {}
  async gitPush() {}
  async gitBranch() {}
  async gitCheckout() {}
  async gitDiff() { return ''; }
  async gitLog() { return []; }
  async gitBranches() { return []; }

  async lspConnect() {
    return {
      languageId: '',
      request: async () => null,
      notify: () => {},
      onNotification: () => () => {},
      disconnect: () => {},
    };
  }
  async lspHealth() {
    return { languageId: '', status: 'stopped' as const };
  }
  async lspRestart() {}
  async lspServers() { return []; }

  async terminalAuth() {
    return { token: 'test', endpoint: 'ws://localhost/ws/pty', expiresAt: Date.now() + 3600000 };
  }

  async debugLaunch() { return { id: 'test', config: {} as DebugConfig, status: 'running' as const }; }
  async debugControl() {}
  async debugGetVariables() { return []; }
  async debugGetStackFrames() { return []; }

  async requestPermission() { return true; }
  async confirmDestructive() { return this.confirmResult; }
  notify() {}
  emit(event: HostEvent) { this.eventBus.emit(event); }
}
