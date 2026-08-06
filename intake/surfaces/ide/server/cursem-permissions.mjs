// === CURSEM IDE — CLI permission matrix (server-authoritative) =============
//
// Single source of truth for the in-shell `cursem` CLI permission model:
//   - master switch (cliEnabled)
//   - surface (row) × access (Read/Control column) cells
//   - method → cell resolution (unlisted verbs in a covered namespace fall
//     into the CONTROL cell — new verbs fail strict, never escape)
//
// The gate lives SERVER-side (cursem-control.mjs) because the control endpoint
// is reachable from any shell on loopback. The frontend mirrors this module in
// src/platform/cliPermissions.ts for the Settings UI; tests/cliPermissions
// .test.ts pins the two copies together so they cannot drift.

export const CONTROL_API_VERSION = 1;

export const DEFAULT_CLI_SETTINGS = Object.freeze({
  cliEnabled: true,
  cliTerminalReadEnabled: true,
  // Keystroke injection into live shells ships OFF — explicit opt-in only.
  cliTerminalInputEnabled: false,
  cliSurfaceReadEnabled: true,
  cliSurfaceControlEnabled: true,
  cliEditorReadEnabled: true,
  cliEditorControlEnabled: true,
  cliNotificationsEnabled: true,
});

/**
 * The matrix the Settings UI renders. `read: null` means the surface has no
 * read-only verbs yet (the cell is reserved so future read verbs gate strict).
 */
export const CLI_PERMISSION_MATRIX = Object.freeze([
  Object.freeze({
    id: 'terminal',
    label: 'Terminal',
    read: Object.freeze({
      key: 'cliTerminalReadEnabled',
      label: 'Read terminal output',
      description: 'Allow `cursem terminal read` to capture the rendered screen of any terminal session.',
    }),
    control: Object.freeze({
      key: 'cliTerminalInputEnabled',
      label: 'Inject terminal input',
      description: 'Allow `cursem terminal type` / `press` to write keystrokes into live shells. Off by default.',
    }),
  }),
  Object.freeze({
    id: 'surface',
    label: 'Surfaces',
    read: Object.freeze({
      key: 'cliSurfaceReadEnabled',
      label: 'List surfaces',
      description: 'Allow `cursem surface list` to enumerate editor tabs and terminal sessions.',
    }),
    control: Object.freeze({
      key: 'cliSurfaceControlEnabled',
      label: 'Manage surfaces',
      description: 'Allow `cursem surface focus` / `close` / `set-title`.',
    }),
  }),
  Object.freeze({
    id: 'editor',
    label: 'Editor',
    read: Object.freeze({
      key: 'cliEditorReadEnabled',
      label: 'Read editor state',
      description: 'Reserved for future editor read verbs.',
    }),
    control: Object.freeze({
      key: 'cliEditorControlEnabled',
      label: 'Open files',
      description: 'Allow `cursem editor open` to open workspace files, optionally at a line:column.',
    }),
  }),
  Object.freeze({
    id: 'notifications',
    label: 'Notifications',
    read: null,
    control: Object.freeze({
      key: 'cliNotificationsEnabled',
      label: 'Post notifications',
      description: 'Allow `cursem ui notify` to post in-app toasts and desktop notifications.',
    }),
  }),
]);

/** Methods explicitly classified as Read; anything else under a covered
 *  namespace is Control (fail strict). */
const READ_METHODS = Object.freeze({
  terminal: Object.freeze(new Set(['cursem.terminal.read'])),
  surface: Object.freeze(new Set(['cursem.surface.list'])),
  editor: Object.freeze(new Set()),
  notifications: Object.freeze(new Set()),
});

/** Every method the v1 dispatch core accepts. Unknown methods are rejected
 *  with `unsupported` BEFORE the permission gate (Cate gate order). */
export const SUPPORTED_METHODS = Object.freeze(new Set([
  'cursem.version',
  'cursem.terminal.read',
  'cursem.terminal.type',
  'cursem.terminal.press',
  'cursem.editor.openFile',
  'cursem.surface.list',
  'cursem.surface.focus',
  'cursem.surface.close',
  'cursem.surface.setTitle',
  'cursem.ui.notify',
]));

/** Ungated methods — answered without touching the permission matrix. */
const UNGATED_METHODS = Object.freeze(new Set(['cursem.version']));

/**
 * Resolve a method to its permission cell.
 * @param {string} method e.g. 'cursem.terminal.type'
 * @returns {{ surface: string, access: 'read'|'control', key: string, label: string } | null}
 *   null when the method is ungated or outside every covered namespace.
 */
export function cliPermissionForMethod(method) {
  if (UNGATED_METHODS.has(method)) return null;
  const namespace = String(method || '').split('.')[1] || '';
  const surface = CLI_PERMISSION_MATRIX.find((entry) => entry.id === namespace);
  if (!surface) return null;
  const access = READ_METHODS[namespace]?.has(method) ? 'read' : 'control';
  const cell = surface[access] ?? surface.control ?? surface.read;
  if (!cell) return null;
  return { surface: namespace, access, key: cell.key, label: cell.label };
}

/** Merge a partial update into a settings object; only known boolean keys stick. */
export function mergeCliSettings(current, patch) {
  const next = { ...current };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return next;
  for (const key of Object.keys(DEFAULT_CLI_SETTINGS)) {
    if (typeof patch[key] === 'boolean') next[key] = patch[key];
  }
  return next;
}
