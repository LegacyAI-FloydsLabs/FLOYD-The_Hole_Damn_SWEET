import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMigrationService } from '../server/migration-service.mjs';

const temporaryDirectories = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('read-only editor profile migration', () => {
  it('maps only supported Cursor settings and reports unsupported artifacts honestly', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cursem-migration-')); temporaryDirectories.push(home);
    const user = join(home, 'Library', 'Application Support', 'Cursor', 'User');
    await mkdir(join(user, 'snippets'), { recursive: true });
    await mkdir(join(home, '.cursor', 'extensions', 'ms-python.python-2026.4.0'), { recursive: true });
    await mkdir(join(home, '.cursor', 'extensions', 'vendor.unknown-1.2.3'), { recursive: true });
    const source = `{
      // Supported settings are mapped, unrelated and secret values stay server-side.
      "editor.fontSize": 18,
      "editor.fontFamily": "JetBrains Mono, https://font.example",
      "editor.wordWrap": "off",
      "files.autoSave": "afterDelay",
      "vendor.apiKey": "must-not-leak",
    }`;
    await writeFile(join(user, 'settings.json'), source);
    await writeFile(join(user, 'keybindings.json'), '[{"key":"cmd+x","command":"custom"}]');
    await writeFile(join(user, 'snippets', 'typescript.json'), '{}');

    const preview = await createMigrationService({ homeDir: home }).preview('cursor');
    expect(preview.preferences).toEqual({ fontSize: 18, wordWrap: false, autoSave: true, fontFamily: 'jetbrains-mono' });
    expect(JSON.stringify(preview)).not.toContain('must-not-leak');
    expect(preview.keybindings).toMatchObject({ count: 1, status: 'unsupported' });
    expect(preview.snippets).toMatchObject({ count: 1, status: 'unsupported' });
    expect(preview.extensions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ms-python.python', classification: 'replaced' }),
      expect.objectContaining({ id: 'vendor.unknown', classification: 'unsupported' }),
    ]));
    expect(await readFile(join(user, 'settings.json'), 'utf8')).toBe(source);
  });

  it('returns a non-mutating empty preview when the profile is absent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cursem-migration-empty-')); temporaryDirectories.push(home);
    await expect(createMigrationService({ homeDir: home }).preview('vscode')).resolves.toMatchObject({ source: 'vscode', found: false, preferences: {}, extensions: [] });
    await expect(createMigrationService({ homeDir: home }).preview('other')).rejects.toMatchObject({ status: 400 });
  });
});
