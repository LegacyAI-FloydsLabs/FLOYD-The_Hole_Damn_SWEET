// CURSE'M IDE — Platform re-exports for clean imports.

export type {
  AuthUser,
  AuthSession,
  Project,
  Workspace,
  GitRepositoryRef,
  OpenCodeInstance,
  OpenCodeSession,
  AgentConfig,
  AgentRunStatus,
  AgentMessage,
  AgentRun,
  AgentRunEvent,
  AgentThread,
  AgentPatchChange,
  AgentPatchFile,
  AgentPatchHunk,
  AgentPatchPreview,
  AgentCheckpoint,
  ContextIndexStatus,
  ContextSearchResult,
  ContextSelector,
  ResolvedContextItem,
  ResolvedContext,
  AgentRule,
  AgentRuleSet,
  AgentMemory,
  AgentTaskRequest,
  AgentTaskResult,
  McpServerInfo,
  McpTool,
  MigrationExtension,
  MigrationPreview,
  WorkspaceTask,
  TerminalOneSession,
  Theme,
  PlatformNotification,
  Permission,
  Diagnostic,
  DirEntry,
  FileStat,
  FileWatchEvent,
  GitStatus,
  GitChangedFile,
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
  OpenCodeContext,
  PlatformConfig,
  HostEvent,
  HostEventType,
  SupportedLanguage,
} from './types';

export { SUPPORTED_LANGUAGES } from './types';

export { PlatformEventBus } from './events';
export type { EventHandler } from './events';

export type { HostGateway, LspConnection } from './host';
export { HttpHostGateway, MockHostGateway } from './host';

export { HostProvider, PlatformContext } from './HostProvider';
export type { PlatformContextValue, HostProviderProps } from './HostProvider';

export { usePlatform, useGateway, useEventBus, useConfig } from './usePlatform';
