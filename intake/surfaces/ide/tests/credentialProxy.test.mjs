// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkCredentialProxy, qualifyProxyModel, resolveCredentialProxy } from '../server/credential-proxy.mjs';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function capabilityFile(mode = 0o600) {
  const root = await mkdtemp(join(tmpdir(), 'cursem-proxy-'));
  roots.push(root);
  const path = join(root, 'capability.token');
  await writeFile(path, 'app-capability\n', { mode });
  await chmod(path, mode);
  return path;
}

describe('credential proxy capability', () => {
  it('loads an owner-only app capability without exposing a provider credential', async () => {
    const tokenFile = await capabilityFile();
    const result = await resolveCredentialProxy({
      env: {
        CURSEM_CREDENTIAL_PROXY_URL: 'http://127.0.0.1:4000',
        CURSEM_CREDENTIAL_PROXY_TOKEN_FILE: tokenFile,
      },
    });

    expect(result.url.origin).toBe('http://127.0.0.1:4000');
    expect(result.token).toBe('app-capability');
    expect(JSON.stringify({ url: result.url.origin })).not.toContain(result.token);
  });

  it('rejects capability files readable by another user class', async () => {
    const tokenFile = await capabilityFile(0o640);
    await expect(resolveCredentialProxy({
      env: {
        CURSEM_CREDENTIAL_PROXY_URL: 'http://127.0.0.1:4000',
        CURSEM_CREDENTIAL_PROXY_TOKEN_FILE: tokenFile,
      },
    })).rejects.toThrow('owner-only');
  });

  it('rejects non-loopback proxy destinations', async () => {
    await expect(resolveCredentialProxy({
      env: {
        CURSEM_CREDENTIAL_PROXY_URL: 'https://proxy.example',
        CURSEM_CREDENTIAL_PROXY_TOKEN: 'capability',
      },
    })).rejects.toThrow('loopback');
  });

  it('returns a secret-free health receipt', async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(String(url)).toBe('http://127.0.0.1:4000/healthz');
      return new Response(JSON.stringify({ ok: true, version: '17.0.5' }), { status: 200 });
    });
    const result = await checkCredentialProxy({
      env: {
        CURSEM_CREDENTIAL_PROXY_URL: 'http://127.0.0.1:4000',
        CURSEM_CREDENTIAL_PROXY_TOKEN: 'capability',
      },
      fetchImpl,
    });

    expect(result).toEqual({ url: 'http://127.0.0.1:4000', version: '17.0.5' });
    expect(JSON.stringify(result)).not.toContain('capability');
  });

  it('qualifies ambiguous model ids with the selected provider exactly once', () => {
    expect(qualifyProxyModel('anthropic', 'claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6');
    expect(qualifyProxyModel('anthropic', 'anthropic/claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6');
  });
});
