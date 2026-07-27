import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_PROXY_URL = 'http://127.0.0.1:4000';

/**
 * Resolve CURSEM's local model capability without reading a provider secret.
 *
 * The bearer authorizes this app to call the already-running credential proxy;
 * the proxy owns provider credentials, refresh, and rotation. The generic
 * environment names allow the current OMP-compatible listener and its planned
 * JCODE replacement to use the same CURSEM integration.
 */
export async function resolveCredentialProxy({ env = process.env } = {}) {
  const rawUrl = env.CURSEM_CREDENTIAL_PROXY_URL || env.JCODE_CREDENTIAL_PROXY_URL || env.OMP_AUTH_GATEWAY_URL || DEFAULT_PROXY_URL;
  const url = validateProxyUrl(rawUrl);
  const explicitToken = env.CURSEM_CREDENTIAL_PROXY_TOKEN || env.JCODE_CREDENTIAL_PROXY_TOKEN;
  const tokenFile = env.CURSEM_CREDENTIAL_PROXY_TOKEN_FILE
    || env.JCODE_CREDENTIAL_PROXY_TOKEN_FILE
    || join(env.HOME || homedir(), '.omp', 'auth-gateway.token');
  const token = explicitToken?.trim() || await readCapabilityToken(tokenFile);
  if (!token) throw new Error('The local credential proxy capability token is unavailable.');
  return { url, token };
}

/** Secret-free startup health receipt. */
export async function checkCredentialProxy({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const { url } = await resolveCredentialProxy({ env });
  const response = await fetchImpl(new URL('/healthz', url), { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`Credential proxy health check failed with HTTP ${response.status}.`);
  const health = await response.json().catch(() => ({}));
  if (health?.ok !== true) throw new Error('Credential proxy health response was not ready.');
  return { url: url.origin, version: typeof health.version === 'string' ? health.version : null };
}

/** Bind ambiguous model ids to the provider the user selected. */
export function qualifyProxyModel(providerId, model) {
  const normalizedProvider = String(providerId || '').trim();
  const normalizedModel = String(model || '').trim();
  if (!normalizedProvider || !normalizedModel) throw new Error('Provider and model are required for credential-proxy routing.');
  return normalizedModel.startsWith(`${normalizedProvider}/`) ? normalizedModel : `${normalizedProvider}/${normalizedModel}`;
}

function validateProxyUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); }
  catch { throw new Error('Credential proxy URL must be an absolute URL.'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Credential proxy URL must use HTTP or HTTPS.');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Credential proxy URL cannot contain credentials, a query, or a fragment.');
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
    throw new Error('Credential proxy must use a loopback address.');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed;
}

async function readCapabilityToken(path) {
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Credential proxy capability token file was not found: ${path}`);
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('Credential proxy capability token must be a regular file.');
  if ((metadata.mode & 0o077) !== 0) throw new Error('Credential proxy capability token file must be owner-only.');
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) throw new Error('Credential proxy capability token file must be owned by the current user.');
  return (await readFile(path, 'utf8')).trim();
}
