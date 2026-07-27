import { describe, expect, it, vi } from 'vitest';
import { LspService, SUPPORTED_LSP_LANGUAGES, supportsLspLanguage } from '@/lsp';
import { MockHostGateway } from '@/platform/host';

describe('LspService language activation', () => {
  it('does not open a gateway connection for unsupported editor languages', async () => {
    const gateway = new MockHostGateway();
    const connect = vi.spyOn(gateway, 'lspConnect');
    const service = new LspService(gateway);

    await service.openDocument('plaintext', '/test/workspace/notes.txt', 'hello');
    service.changeDocument('plaintext', '/test/workspace/notes.txt', 'updated');

    await expect(service.requestCompletion('plaintext', '/test/workspace/notes.txt', 1, 0)).resolves.toEqual([]);
    await expect(service.requestHover('plaintext', '/test/workspace/notes.txt', 1, 0)).resolves.toBeNull();
    await expect(service.requestDefinition('plaintext', '/test/workspace/notes.txt', 1, 0)).resolves.toEqual([]);
    await expect(service.requestReferences('plaintext', '/test/workspace/notes.txt', 1, 0)).resolves.toEqual([]);
    await expect(service.requestRename('plaintext', '/test/workspace/notes.txt', 1, 0, 'next')).resolves.toEqual([]);
    await expect(service.requestFormatting('plaintext', '/test/workspace/notes.txt')).resolves.toEqual([]);

    expect(connect).not.toHaveBeenCalled();
    expect(supportsLspLanguage('plaintext')).toBe(false);
  });

  it('retains gateway activation for every server-backed language', async () => {
    const gateway = new MockHostGateway();
    const connect = vi.spyOn(gateway, 'lspConnect');
    const service = new LspService(gateway);

    expect(SUPPORTED_LSP_LANGUAGES).toEqual([
      'typescript', 'javascript', 'javascriptreact', 'typescriptreact',
      'json', 'html', 'css', 'python', 'shell', 'rust',
    ]);
    await service.openDocument('typescript', '/test/workspace/app.ts', 'export {};');

    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith('typescript');
    expect(supportsLspLanguage('typescript')).toBe(true);
  });
});
