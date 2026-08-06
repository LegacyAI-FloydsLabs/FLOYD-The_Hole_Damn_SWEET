// CURSE'M IDE — CLI permission matrix (frontend mirror).
//
// TypeScript mirror of server/cursem-permissions.mjs — the AUTHORITATIVE gate
// is server-side (the control endpoint is reachable from any shell on
// loopback); this copy exists so the Settings UI renders the exact matrix the
// gate enforces, and both copies read from the same declarative shape.
// tests/cliPermissions.test.ts pins the two copies together so they cannot
// drift.

export const CONTROL_API_VERSION = 1;

export interface CliSettings {
  cliEnabled: boolean;
  cliTerminalReadEnabled: boolean;
  cliTerminalInputEnabled: boolean;
  cliSurfaceReadEnabled: boolean;
  cliSurfaceControlEnabled: boolean;
  cliEditorReadEnabled: boolean;
  cliEditorControlEnabled: boolean;
  cliNotificationsEnabled: boolean;
}

export const DEFAULT_CLI_SETTINGS: CliSettings = {
  cliEnabled: true,
  cliTerminalReadEnabled: true,
  // Keystroke injection into live shells ships OFF — explicit opt-in only.
  cliTerminalInputEnabled: false,
  cliSurfaceReadEnabled: true,
  cliSurfaceControlEnabled: true,
  cliEditorReadEnabled: true,
  cliEditorControlEnabled: true,
  cliNotificationsEnabled: true,
};

export interface CliPermissionCell {
  key: keyof CliSettings;
  label: string;
  description: string;
}

export interface CliPermissionSurface {
  id: 'terminal' | 'surface' | 'editor' | 'notifications';
  label: string;
  /** null = the surface has no read-only verbs yet (reserved cell). */
  read: CliPermissionCell | null;
  control: CliPermissionCell | null;
}

export const CLI_PERMISSION_MATRIX: CliPermissionSurface[] = [
  {
    id: 'terminal',
    label: 'Terminal',
    read: {
      key: 'cliTerminalReadEnabled',
      label: 'Read terminal output',
      description: 'Allow `cursem terminal read` to capture the rendered screen of any terminal session.',
    },
    control: {
      key: 'cliTerminalInputEnabled',
      label: 'Inject terminal input',
      description: 'Allow `cursem terminal type` / `press` to write keystrokes into live shells. Off by default.',
    },
  },
  {
    id: 'surface',
    label: 'Surfaces',
    read: {
      key: 'cliSurfaceReadEnabled',
      label: 'List surfaces',
      description: 'Allow `cursem surface list` to enumerate editor tabs and terminal sessions.',
    },
    control: {
      key: 'cliSurfaceControlEnabled',
      label: 'Manage surfaces',
      description: 'Allow `cursem surface focus` / `close` / `set-title`.',
    },
  },
  {
    id: 'editor',
    label: 'Editor',
    read: {
      key: 'cliEditorReadEnabled',
      label: 'Read editor state',
      description: 'Reserved for future editor read verbs.',
    },
    control: {
      key: 'cliEditorControlEnabled',
      label: 'Open files',
      description: 'Allow `cursem editor open` to open workspace files, optionally at a line:column.',
    },
  },
  {
    id: 'notifications',
    label: 'Notifications',
    read: null,
    control: {
      key: 'cliNotificationsEnabled',
      label: 'Post notifications',
      description: 'Allow `cursem ui notify` to post in-app toasts and desktop notifications.',
    },
  },
];

const READ_METHODS: Record<string, ReadonlySet<string>> = {
  terminal: new Set(['cursem.terminal.read']),
  surface: new Set(['cursem.surface.list']),
  editor: new Set(),
  notifications: new Set(),
};

export interface CliPermissionResolution {
  surface: string;
  access: 'read' | 'control';
  key: keyof CliSettings;
  label: string;
}

/** Resolve a method to its permission cell — same rule as the server gate:
 *  unlisted verbs in a covered namespace fall into CONTROL (fail strict). */
export function cliPermissionForMethod(method: string): CliPermissionResolution | null {
  if (method === 'cursem.version') return null;
  const namespace = method.split('.')[1] ?? '';
  const surface = CLI_PERMISSION_MATRIX.find((entry) => entry.id === namespace);
  if (!surface) return null;
  const access: 'read' | 'control' = READ_METHODS[namespace]?.has(method) ? 'read' : 'control';
  const cell = surface[access] ?? surface.control ?? surface.read;
  if (!cell) return null;
  return { surface: namespace, access, key: cell.key, label: cell.label };
}
