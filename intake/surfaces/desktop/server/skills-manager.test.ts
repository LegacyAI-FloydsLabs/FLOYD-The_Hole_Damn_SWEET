import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillsManager } from './skills-manager';

const testDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(testDirectories.splice(0).map(directory =>
    fs.rm(directory, { recursive: true, force: true }),
  ));
});

describe('SkillsManager activation', () => {
  it('returns the resulting state and rejects unknown skill IDs', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'floyd-skills-'));
    testDirectories.push(directory);
    const manager = new SkillsManager(directory);
    await manager.init();

    expect(await manager.activate('explain')).toBe(true);
    expect(manager.isActive('explain')).toBe(true);
    expect(await manager.deactivate('explain')).toBe(true);
    expect(manager.isActive('explain')).toBe(false);
    expect(await manager.activate('missing')).toBe(false);
    expect(await manager.deactivate('missing')).toBe(false);
  });
});

