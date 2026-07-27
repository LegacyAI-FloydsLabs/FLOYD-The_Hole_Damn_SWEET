// CURSE'M IDE — Security: Auth (§9).
//
// §9: "No secrets in frontend bundles, IndexedDB, localStorage, logs, or Git."
// §9: "Authenticate all filesystem, Git, LSP, debug, and terminal connections."
// §9: "Separate frontend rendering from privileged host operations."
//
// Auth tokens are NEVER stored in browser storage. They are passed via
// the HostGateway (from Floyd Desktop) and included in API requests
// by the gateway implementation. The frontend never touches them directly.

import type { HostGateway, AuthSession } from '@/platform';

/**
 * Get the current auth session. The token is held in the gateway's
 * memory — it is never persisted to browser storage.
 */
export async function getAuthSession(gateway: HostGateway): Promise<AuthSession | null> {
  return gateway.getAuthSession();
}

/**
 * Check if the user has a specific permission (§9: "permissions").
 */
export async function hasPermission(
  gateway: HostGateway,
  resource: string,
  action: string,
): Promise<boolean> {
  return gateway.requestPermission(resource, action);
}

/**
 * Request confirmation for a destructive operation (§9).
 * Uses the gateway's confirmation mechanism — in dev mode this is
 * window.confirm, in production Floyd provides a custom dialog.
 */
export async function confirmDestructive(
  gateway: HostGateway,
  operation: string,
  details: string,
): Promise<boolean> {
  return gateway.confirmDestructive(operation, details);
}
