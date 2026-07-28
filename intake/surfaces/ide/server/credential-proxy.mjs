/**
 * Resolve CURSEM's local model capability without reading a provider secret.
 *
 * The bearer authorizes this app to call the already-running credential proxy;
 * the proxy owns provider credentials, refresh, and rotation. The generic
 * environment names allow the current OMP-compatible listener and its planned
 * JCODE replacement to use the same CURSEM integration.
 */
export async function resolveCredentialProxy({ env = process.env } = {}) {
  const rawUrl = env.FLOYD_VAULT_PROXY_URL || env.CURSEM_CREDENTIAL_PROXY_URL;
  if (!rawUrl) throw new Error('CURSEM Vault proxy address is unavailable.');
  const url = validateProxyUrl(rawUrl);
  const token = String(env.FLOYD_VAULT_PROXY_TOKEN || env.CURSEM_CREDENTIAL_PROXY_TOKEN || '').trim();
  if (!/^fv_[A-Za-z0-9_-]+_[0-9a-f]{32,}$/.test(token)) {
    throw new Error('CURSEM Vault capability is unavailable.');
  }
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
