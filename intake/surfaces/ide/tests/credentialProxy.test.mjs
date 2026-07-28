// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { checkCredentialProxy, qualifyProxyModel, resolveCredentialProxy } from '../server/credential-proxy.mjs';

const TOKEN = 'fv_cursem_0123456789abcdef0123456789abcdef0123456789abcdef';

describe('credential proxy capability', () => {
  it('accepts only an fv application capability and loopback Vault address', async () => {
    const result = await resolveCredentialProxy({
      env: {
        FLOYD_VAULT_PROXY_URL: 'http://127.0.0.1:13031',
        FLOYD_VAULT_PROXY_TOKEN: TOKEN,
      },
    });

    expect(result.url.origin).toBe('http://127.0.0.1:13031');
    expect(result.token).toBe(TOKEN);
    expect(JSON.stringify({ url: result.url.origin })).not.toContain(TOKEN);
  });

  it('does not fall back to a legacy token file or direct provider key', async () => {
    await expect(resolveCredentialProxy({
      env: {
        CURSEM_CREDENTIAL_PROXY_URL: 'http://127.0.0.1:13031',
        CURSEM_CREDENTIAL_PROXY_TOKEN_FILE: '/tmp/obsolete-provider-key',
        ANTHROPIC_API_KEY: 'must-not-win',
      },
    })).rejects.toThrow('Vault capability is unavailable');
  });

  it('rejects non-loopback proxy destinations', async () => {
    await expect(resolveCredentialProxy({
      env: {
        FLOYD_VAULT_PROXY_URL: 'https://proxy.example',
        FLOYD_VAULT_PROXY_TOKEN: TOKEN,
      },
    })).rejects.toThrow('loopback');
  });

  it('returns a secret-free health receipt', async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(String(url)).toBe('http://127.0.0.1:13031/healthz');
      return new Response(JSON.stringify({ ok: true, version: '17.0.5' }), { status: 200 });
    });
    const result = await checkCredentialProxy({
      env: {
        FLOYD_VAULT_PROXY_URL: 'http://127.0.0.1:13031',
        FLOYD_VAULT_PROXY_TOKEN: TOKEN,
      },
      fetchImpl,
    });

    expect(result).toEqual({ url: 'http://127.0.0.1:13031', version: '17.0.5' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('qualifies ambiguous model ids with the selected provider exactly once', () => {
    expect(qualifyProxyModel('anthropic', 'claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6');
    expect(qualifyProxyModel('anthropic', 'anthropic/claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6');
  });
});
