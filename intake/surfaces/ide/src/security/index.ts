// CURSE'M IDE — Security re-exports.

export { getAuthSession, hasPermission, confirmDestructive } from './auth';
export { ConfirmationDialog, useConfirmation } from './confirmation';
export type { ConfirmationRequest } from './confirmation';
export { getAllowedOrigins, isUrlAllowed, getWorkspaceRoot } from './config';
