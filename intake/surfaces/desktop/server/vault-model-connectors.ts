export type DesktopModelConnector = Readonly<{
  id: string;
  displayName: string;
  dialect: 'openai' | 'anthropic';
  configured: boolean;
}>;

type ConnectorCatalogOptions = Readonly<{
  vaultUrl: string;
  vaultToken: string;
  fetchImpl?: typeof globalThis.fetch;
  signal?: AbortSignal;
}>;
export type DesktopVaultStatus = Readonly<{
  subscriptionConfigured: boolean;
  configuredProviders: string[];
}>;
export type DesktopProvider = 'chatgpt-subscription' | 'anthropic' | 'openai' | 'glm' | 'anthropic-compatible';

const CONNECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Read the Vault-redacted connector catalog with Desktop's fv_ capability. */
export async function listVaultModelConnectors(options: ConnectorCatalogOptions): Promise<DesktopModelConnector[]> {
  const vaultUrl = exactVaultUrl(options.vaultUrl);
  if (!/^fv_desktop_[0-9a-f]{32,}$/.test(options.vaultToken)) {
    throw new Error('Desktop model connectors require the persistent fv_desktop_ Vault capability');
  }
  const response = await (options.fetchImpl ?? globalThis.fetch)(`${vaultUrl}/connectors/catalog`, {
    method: 'GET',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${options.vaultToken}`,
      accept: 'application/json',
    },
    signal: options.signal,
  });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Vault connector catalog returned HTTP ${response.status}`);
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { connectors?: unknown }).connectors)) {
    throw new Error('Vault connector catalog response is invalid');
  }
  return (payload as { connectors: unknown[] }).connectors.map(publicConnector);
}

export async function readDesktopVaultStatus(options: ConnectorCatalogOptions): Promise<DesktopVaultStatus> {
  const vaultUrl = exactVaultUrl(options.vaultUrl);
  if (!/^fv_desktop_[0-9a-f]{32,}$/.test(options.vaultToken)) {
    throw new Error('Desktop Vault status requires the persistent fv_desktop_ capability');
  }
  const response = await (options.fetchImpl ?? globalThis.fetch)(`${vaultUrl}/status`, {
    method: 'GET',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${options.vaultToken}`,
      accept: 'application/json',
    },
    signal: options.signal,
  });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok || !payload || typeof payload !== 'object') {
    throw new Error(`Vault status returned HTTP ${response.status}`);
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.subscriptionConfigured !== 'boolean'
    || !Array.isArray(record.configuredProviders)
    || record.configuredProviders.some((provider) => typeof provider !== 'string')) {
    throw new Error('Vault status response is invalid');
  }
  return Object.freeze({
    subscriptionConfigured: record.subscriptionConfigured,
    configuredProviders: [...new Set(record.configuredProviders)].sort(),
  });
}

/** SDK base URL that can target only the loopback Vault connector invoke route. */
export function vaultConnectorBaseURL(vaultUrlInput: string, connectorId: string): string {
  const vaultUrl = exactVaultUrl(vaultUrlInput);
  if (!CONNECTOR_ID.test(connectorId)) throw new Error('Vault connector selection is invalid');
  return `${vaultUrl}/connectors/${encodeURIComponent(connectorId)}/invoke`;
}

export function isDesktopProviderReady(
  provider: DesktopProvider,
  connectorId: string | undefined,
  status: DesktopVaultStatus,
  connectors: DesktopModelConnector[],
): boolean {
  if (provider === 'chatgpt-subscription') return status.subscriptionConfigured;
  if (provider === 'anthropic-compatible') {
    return Boolean(connectors.find((connector) =>
      connector.id === connectorId
      && connector.dialect === 'anthropic'
      && connector.configured));
  }
  const vaultProvider = provider === 'glm' ? 'zai' : provider;
  return status.configuredProviders.includes(vaultProvider);
}

function publicConnector(input: unknown): DesktopModelConnector {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Vault connector catalog entry is invalid');
  }
  const row = input as Record<string, unknown>;
  if (typeof row.id !== 'string' || !CONNECTOR_ID.test(row.id)
    || typeof row.displayName !== 'string' || !row.displayName.trim()
    || (row.dialect !== 'openai' && row.dialect !== 'anthropic')
    || typeof row.configured !== 'boolean') {
    throw new Error('Vault connector catalog entry is invalid');
  }
  return Object.freeze({
    id: row.id,
    displayName: row.displayName,
    dialect: row.dialect,
    configured: row.configured,
  });
}

function exactVaultUrl(input: string): string {
  let parsed: URL;
  try { parsed = new URL(input); } catch { throw new Error('Desktop Vault address is invalid'); }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1'
    || !parsed.port || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Desktop Vault address must be an HTTP loopback origin');
  }
  return parsed.origin;
}
