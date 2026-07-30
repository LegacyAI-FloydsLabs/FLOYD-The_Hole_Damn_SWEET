// CURSE'M IDE — Platform Contract Types (§8).
//
// "The IDE must consume these shared platform concepts rather than
// inventing its own."
//
// These types define the contract between the IDE and the Floyd platform.
// The IDE never invents its own versions of these — it consumes them
// from the HostGateway.

// ─── Authenticated user/session ───────────────────────────────────────

export interface AuthUser {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  roles: string[];
}

export interface AuthSession {
  /** Opaque token — never stored in browser storage (§9). Passed via gateway. */
  token: string;
  expiresAt: number;
  user: AuthUser;
}

// ─── Active project ───────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  type?: string;
}

// ─── Workspace root ───────────────────────────────────────────────────

export interface Workspace {
  id: string;
  /** Real filesystem path — the canonical workspace (§2). */
  root: string;
  project: Project;
  /** Multiple repositories and Git worktrees (§2). */
  repositories: GitRepositoryRef[];
}

export interface GitRepositoryRef {
  id: string;
  path: string;
  branch: string;
  isWorktree: boolean;
  remoteUrl?: string;
}

// ─── OpenCode instance ────────────────────────────────────────────────

export interface OpenCodeInstance {
  id: string;
  /** Legacy Floyd-managed OpenCode instance URL retained for host compatibility. */
  url: string;
  status: 'running' | 'stopped' | 'starting';
}

// ─── OpenCode session ─────────────────────────────────────────────────

export interface OpenCodeSession {
  id: string;
  instanceId: string;
  title?: string;
  status: 'active' | 'idle' | 'error';
  createdAt: number;
}

// ─── Active model and agent ───────────────────────────────────────────

export interface AgentConfig {
  id: string;
  name: string;
  modelId: string;
  modelName: string;
}

export type AgentRunStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export interface AgentMessage {
  id: string;
  threadId: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface AgentRun {
  id: string;
  threadId: string;
  status: AgentRunStatus;
  provider: string;
  model: string;
  startedAt: number;
  updatedAt: number;
  summary: Record<string, unknown>;
  events?: AgentRunEvent[];
}

export interface AgentRunEvent {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface AgentThread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages?: AgentMessage[];
  runs?: AgentRun[];
}

export interface AgentPatchChange {
  path: string;
  content: string | null;
}

export interface AgentPatchFile {
  path: string;
  operation: 'create' | 'modify' | 'delete';
  beforeHash: string | null;
  afterHash: string | null;
  stats: { oldLines: number; newLines: number; delta: number };
  hunks: AgentPatchHunk[];
}

export interface AgentPatchHunk {
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  beforeLines: string[];
  afterLines: string[];
}

export interface AgentPatchPreview {
  proposalId: string;
  expiresAt: number;
  files: AgentPatchFile[];
}

export interface AgentCheckpoint {
  id: string;
  runId: string | null;
  label: string;
  files: Array<{ path: string; beforeHash: string | null; afterHash: string | null }>;
  createdAt: number;
}

export interface ContextIndexStatus {
  root: string;
  files: number;
  bytes: number;
  indexedAt: number;
  dirty: boolean;
  indexing: boolean;
}

export interface ContextSearchResult {
  path: string;
  score: number;
  reasons: string[];
  symbols: string[];
  snippet: string;
}

export interface ContextSelector {
  type: 'file' | 'folder' | 'symbol';
  value: string;
}

export interface ResolvedContextItem {
  path: string;
  content: string;
  reason: string;
  chars: number;
  truncated: boolean;
}

export interface ResolvedContext {
  items: ResolvedContextItem[];
  totalChars: number;
  budgetChars: number;
}

export interface AgentRule {
  path: string;
  source: 'root' | 'cursor' | 'cursem';
  description: string;
  globs: string[];
  alwaysApply: boolean;
  content: string;
  chars: number;
}

export interface AgentRuleSet {
  applied: AgentRule[];
  available: AgentRule[];
}

export interface AgentMemory {
  id: string;
  content: string;
  source: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentTaskRequest {
  executable: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface AgentTaskResult {
  executable: string;
  args: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: string | null;
  durationMs: number;
}

export interface McpServerInfo {
  id: string;
  scope: 'user' | 'cursor-project' | 'project';
  transport: 'stdio' | 'http';
  source: string;
  command?: string;
  args?: string[];
  url?: string;
  envKeys: string[];
  status: 'connected' | 'disconnected';
  pid?: number;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface MigrationExtension {
  id: string;
  classification: 'replaced' | 'unsupported';
  reason: string;
}

export interface MigrationPreview {
  source: 'cursor' | 'vscode';
  label: string;
  found: boolean;
  sourcePaths: { settings: string | null; keybindings: string | null };
  preferences: Record<string, string | number | boolean>;
  importedKeys: string[];
  keybindings: { count: number; status: 'unsupported'; reason: string };
  snippets: { count: number; names: string[]; status: 'unsupported'; reason: string };
  extensions: MigrationExtension[];
}

export interface WorkspaceTask {
  id: string;
  label: string;
  executable: string;
  args: string[];
  kind: 'task' | 'test';
  source: string;
}

// ─── TerminalOne sessions ─────────────────────────────────────────────

export interface TerminalOneSession {
  id: string;
  title: string;
  /** Working directory — must match active Floyd workspace (§6). */
  cwd: string;
  status: 'connected' | 'disconnected' | 'error';
  pid?: number;
  /** Recovery metadata from TerminalOne admin session tracking. */
  resumable?: boolean;
  attached?: boolean;
}

// ─── Theme ────────────────────────────────────────────────────────────

export interface Theme {
  id: string;
  name: string;
  isDark: boolean;
  colors: Record<string, string>;
  /** Monaco editor theme name for Floyd theme integration (§3). */
  monacoTheme?: string;
}

// ─── Notifications ────────────────────────────────────────────────────

export interface PlatformNotification {
  id: string;
  type: 'info' | 'warning' | 'error' | 'success';
  message: string;
  timestamp: number;
  actions?: Array<{ label: string; action: string }>;
}

// ─── Permissions ──────────────────────────────────────────────────────

export interface Permission {
  resource: string;
  action: string;
  granted: boolean;
}

// ─── Diagnostics ──────────────────────────────────────────────────────

export interface Diagnostic {
  path: string;
  line: number;
  col: number;
  endLine?: number;
  endCol?: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
  code?: string;
}

// ─── Filesystem types (§2) ────────────────────────────────────────────

export interface DirEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink';
  size: number;
  mtimeMs: number;
}

export interface FileStat {
  path: string;
  type: 'file' | 'dir' | 'symlink';
  size: number;
  mtimeMs: number;
  mode?: number;
}

export interface FileWatchEvent {
  type: 'create' | 'modify' | 'delete' | 'rename';
  path: string;
  oldPath?: string;
}

// ─── Git types (§7) ───────────────────────────────────────────────────

export interface GitStatus {
  repoPath: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  prooflineGoverned: boolean;
  changedFiles: GitChangedFile[];
  lastCommit: GitCommit | null;
}

export interface GitChangedFile {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  staged: boolean;
}

export interface GitCommit {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote?: string;
}

// ─── LSP types (§4) ───────────────────────────────────────────────────

export interface LspHealth {
  languageId: string;
  status: 'running' | 'stopped' | 'error' | 'starting';
  pid?: number;
  uptime?: number;
  lastError?: string;
}

export interface LspServerInfo {
  languageId: string;
  name: string;
  version?: string;
}

// Initial language support (§4):
// TypeScript/JavaScript/JSX/TSX, JSON, HTML/CSS, Markdown, Python, Shell, Rust
export const SUPPORTED_LANGUAGES = [
  'typescript', 'javascript', 'javascriptreact', 'typescriptreact',
  'json', 'html', 'css', 'markdown',
  'python', 'shell', 'rust',
] as const;

export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

// ─── Terminal types (§6) ──────────────────────────────────────────────

export interface TerminalAuth {
  /** Authorization token from Floyd platform gateway (§6). */
  token: string;
  /** TerminalOne bridge endpoint (WebSocket URL or IPC path). */
  endpoint: string;
  expiresAt: number;
}

// ─── Debug types (§10) ────────────────────────────────────────────────

export interface DebugConfig {
  name: string;
  type: string;
  request: 'launch' | 'attach';
  program?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Stored per project (§10). */
  projectId: string;
}

export interface DebugSession {
  id: string;
  config: DebugConfig;
  status: 'running' | 'paused' | 'terminated' | 'error';
}

export type DebugCommand =
  | 'continue' | 'pause' | 'step-in' | 'step-over' | 'step-out'
  | 'disconnect';

export interface DebugVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference?: number;
}

export interface DebugStackFrame {
  id: number;
  name: string;
  source: string;
  line: number;
  column: number;
}

// ─── OpenCode context (§5) ────────────────────────────────────────────

export interface OpenCodeContext {
  filePath?: string;
  selection?: {
    startLine: number;
    endLine: number;
    startCol: number;
    endCol: number;
  };
  diagnostics?: Diagnostic[];
  diff?: {
    path: string;
    before: string;
    after: string;
  };
}

// ─── Platform configuration ───────────────────────────────────────────

export interface PlatformConfig {
  workspaceId: string;
  workspaceRoot: string;
  /** Base URL for the host gateway API (dev mode). */
  gatewayUrl: string;
  /** OpenCode instance base URL (§5). */
  opencodeUrl: string;
  /** Base path for asset URLs (§1). */
  basePath: string;
  /** Auth token — passed from Floyd, never stored in browser (§9). */
  authToken?: string;
}

// ─── Host event types (§8) ────────────────────────────────────────────

export type HostEvent =
  | { type: 'file.opened'; path: string }
  | { type: 'file.selected'; path: string }
  | { type: 'selection.changed'; path: string; startLine: number; endLine: number; startCol: number; endCol: number }
  | { type: 'file.saved'; path: string }
  | { type: 'diagnostics.changed'; path: string; diagnostics: Diagnostic[] }
  | { type: 'workspace.changed'; workspaceId: string }
  | { type: 'terminal.requested'; cwd?: string }
  | { type: 'opencode.context.requested'; context: OpenCodeContext };

export type HostEventType = HostEvent['type'];
