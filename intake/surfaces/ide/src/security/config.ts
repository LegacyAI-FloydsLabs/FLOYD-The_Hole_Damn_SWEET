// CURSE'M IDE — Security: Configuration (§9).
//
// §9: "Restrict CORS to Floyd's configured origins."
// §9: "No arbitrary HTTP or Git proxy endpoints."
// §9: "Filesystem operations confined to approved workspace roots."

import type { PlatformConfig } from '@/platform';

/**
 * Get the allowed CORS origins from platform configuration.
 * In production, this comes from Floyd Desktop. In dev, the Vite config
 * handles CORS.
 */
export function getAllowedOrigins(config: PlatformConfig): string[] {
  // The gateway URL is always allowed
  const origins = [new URL(config.gatewayUrl).origin];

  // OpenCode URL is allowed for SSE/fetch
  if (config.opencodeUrl) {
    try {
      origins.push(new URL(config.opencodeUrl).origin);
    } catch { /* invalid URL, skip */ }
  }

  return origins;
}

/**
 * Validate that a URL is within the allowed origins.
 * §9: "No arbitrary HTTP or Git proxy endpoints."
 */
export function isUrlAllowed(url: string, config: PlatformConfig): boolean {
  try {
    const parsed = new URL(url);
    const allowed = getAllowedOrigins(config);
    return allowed.some((origin) => parsed.origin === origin);
  } catch {
    return false;
  }
}

/**
 * Get the workspace root for filesystem confinement.
 * §9: "Filesystem operations confined to approved workspace roots."
 */
export function getWorkspaceRoot(config: PlatformConfig): string {
  return config.workspaceRoot;
}
