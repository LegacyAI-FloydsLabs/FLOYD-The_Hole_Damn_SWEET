// CURSE'M IDE — Workspace re-exports.

export type { ConflictResult } from './FileSystemService';
export { FileSystemService } from './FileSystemService';

export {
  normalizePath,
  hasPathTraversal,
  isWithinWorkspace,
  resolveWorkspacePath,
  validateWorkspacePath,
} from './pathSecurity';
export type { PathValidationResult } from './pathSecurity';

export { WorkspaceProvider, useWorkspace } from './WorkspaceProvider';
export type { WorkspaceContextValue, WorkspaceProviderProps } from './WorkspaceProvider';

export { FileTree } from './FileTree';
export { SearchPanel } from './SearchPanel';
