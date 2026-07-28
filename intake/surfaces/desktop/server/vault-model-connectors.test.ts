import { describe, expect, it, vi } from 'vitest';
import {
  listVaultModelConnectors,
  isDesktopProviderReady,
  readDesktopVaultStatus,
  vaultConnectorBaseURL,
} from './vault-model-connectors.js';

const TOKEN = `fv_desktop_${'1'.repeat(48)}`;

describe('Desktop Vault model connector routing', () => {
  it('reads only the redacted catalog through the Desktop fv_ capability', async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      connectors: [{
        id: 'private-anthropic',
        displayName: 'Private Anthropic',
        dialect: 'anthropic',
        configured: true,
        baseUrl: 'https://must-not-reach-desktop.invalid',
        credentialRef: 'floyd-connector:must-not-reach-desktop',
      }],
    })) as unknown as typeof globalThis.fetch;

    const connectors = await listVaultModelConnectors({
      vaultUrl: 'http://127.0.0.1:13031',
      vaultToken: TOKEN,
      fetchImpl,
    });

    expect(connectors).toEqual([{
      id: 'private-anthropic',
      displayName: 'Private Anthropic',
      dialect: 'anthropic',
      configured: true,
    }]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:13031/connectors/catalog',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }),
      }),
    );
    expect(JSON.stringify(connectors)).not.toContain('https://');
    expect(JSON.stringify(connectors)).not.toContain('credentialRef');
  });

  it('builds only a loopback Vault invoke URL and rejects address or ID substitution', () => {
    expect(vaultConnectorBaseURL('http://127.0.0.1:13031', 'private:anthropic'))
      .toBe('http://127.0.0.1:13031/connectors/private%3Aanthropic/invoke');
    expect(() => vaultConnectorBaseURL('https://vendor.example', 'private')).toThrow(/loopback/);
    expect(() => vaultConnectorBaseURL('http://127.0.0.1:13031', '../vendor')).toThrow(/selection/);
  });

  it('derives provider readiness from authenticated Vault status without exposing keys', async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      subscriptionConfigured: false,
      configuredProviders: ['zai', 'anthropic', 'zai'],
      ignoredSecret: 'must-not-be-returned',
    })) as unknown as typeof globalThis.fetch;
    const status = await readDesktopVaultStatus({
      vaultUrl: 'http://127.0.0.1:13031',
      vaultToken: TOKEN,
      fetchImpl,
    });
    expect(status).toEqual({
      subscriptionConfigured: false,
      configuredProviders: ['anthropic', 'zai'],
    });
    expect(JSON.stringify(status)).not.toContain('ignoredSecret');
    const connectors = [{
      id: 'private-anthropic',
      displayName: 'Private Anthropic',
      dialect: 'anthropic' as const,
      configured: true,
    }];
    expect(isDesktopProviderReady('anthropic', undefined, status, connectors)).toBe(true);
    expect(isDesktopProviderReady('glm', undefined, status, connectors)).toBe(true);
    expect(isDesktopProviderReady('anthropic-compatible', 'private-anthropic', status, connectors)).toBe(true);
    expect(isDesktopProviderReady('anthropic-compatible', 'missing', status, connectors)).toBe(false);
  });
});
