// CURSE'M IDE — Path Security (§9).
//
// §9: "Filesystem operations confined to approved workspace roots."
// §9: "Resolve and reject path traversal and symlink escapes."
//
// Client-side validation catches path traversal patterns before requests
// reach the gateway. Server-side validation (in the gateway) additionally
// resolves symlinks to prevent escape via symlinks — the client cannot
// do this because it has no filesystem access.

/** Normalize a path by resolving . and .. components. Pure string operation. */
export function normalizePath(p: string): string {
  const normalized = p.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const result: string[] = [];

  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (result.length > 0 && result[result.length - 1] !== '..') {
        result.pop();
      } else {
        result.push('..');
      }
      continue;
    }
    result.push(part);
  }

  const hasLeadingSlash = normalized.startsWith('/');
  let joined = result.join('/');
  if (hasLeadingSlash) joined = '/' + joined;
  return joined || (hasLeadingSlash ? '/' : '.');
}

/** Detect path traversal patterns (../ that could escape workspace). */
export function hasPathTraversal(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized.split('/').includes('..');
}

/** Check if a resolved absolute path is within the workspace root. */
export function isWithinWorkspace(path: string, workspaceRoot: string): boolean {
  const np = normalizePath(path);
  const nr = normalizePath(workspaceRoot);
  if (np === nr) return true;
  return np.startsWith(nr + '/');
}

/** Resolve a path (relative or absolute) against the workspace root. */
export function resolveWorkspacePath(pathOrRelative: string, workspaceRoot: string): string {
  if (pathOrRelative.startsWith('/')) {
    return normalizePath(pathOrRelative);
  }
  return normalizePath(`${workspaceRoot}/${pathOrRelative}`);
}

/** Full path validation for workspace operations. */
export interface PathValidationResult {
  valid: boolean;
  resolved: string;
  reason?: string;
}

export function validateWorkspacePath(
  path: string,
  workspaceRoot: string,
): PathValidationResult {
  const resolved = resolveWorkspacePath(path, workspaceRoot);

  if (hasPathTraversal(path)) {
    return { valid: false, resolved, reason: `Path traversal detected: ${path}` };
  }

  if (!isWithinWorkspace(resolved, workspaceRoot)) {
    return { valid: false, resolved, reason: `Path escapes workspace root: ${resolved}` };
  }

  return { valid: true, resolved };
}
