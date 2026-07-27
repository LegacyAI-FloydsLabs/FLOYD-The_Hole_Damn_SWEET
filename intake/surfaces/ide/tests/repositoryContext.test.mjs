// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositoryContext } from '../server/repository-context.mjs';

const execFileAsync = promisify(execFile);
const cleanups = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cursem-context-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await mkdir(join(root, '.cursor', 'rules'), { recursive: true });
  await writeFile(join(root, '.gitignore'), 'ignored.ts\n');
  await writeFile(join(root, '.cursemignore'), 'src/nested/**\n');
  await writeFile(join(root, '.env'), 'SECRET=never-index\n');
  await writeFile(join(root, 'ignored.ts'), 'export const ignoredSecret = true;\n');
  await writeFile(join(root, 'src', 'nested', 'hidden.ts'), 'export const hidden = true;\n');
  await writeFile(join(root, 'src', 'router.ts'), `import { helper } from './util';\nexport function buildRouter() { return helper(); }\n`);
  await writeFile(join(root, 'src', 'util.ts'), 'export const helper = () => 42;\n');
  await writeFile(join(root, 'AGENTS.md'), '# Project instructions\nAlways run tests.\n');
  await writeFile(join(root, '.cursor', 'rules', 'typescript.mdc'), `---\ndescription: TypeScript rules\nglobs: src/**/*.ts\nalwaysApply: false\n---\nUse strict types.\n`);
  await execFileAsync('git', ['init'], { cwd: root });
  return root;
}

describe('local repository context', () => {
  it('indexes Git-visible safe text and retrieves paths, symbols, and snippets', async () => {
    const root = await fixture();
    const context = createRepositoryContext({ workspaceRoot: root });
    const status = await context.refresh();
    expect(status.files).toBeGreaterThanOrEqual(4);
    const results = await context.search('buildRouter', 5);
    expect(results[0]).toMatchObject({ path: 'src/router.ts', reasons: expect.arrayContaining(['symbol buildrouter']) });
    expect((await context.search('never-index')).map((item) => item.path)).not.toContain('.env');
    expect((await context.search('hidden')).map((item) => item.path)).not.toContain('src/nested/hidden.ts');
    context.close();
  });

  it('resolves explicit selectors within a visible budget and explains applied rules', async () => {
    const root = await fixture();
    const context = createRepositoryContext({ workspaceRoot: root });
    await context.refresh();
    const resolved = await context.resolve([{ type: 'symbol', value: 'buildRouter' }, { type: 'file', value: 'src/util.ts' }], 4096);
    expect(resolved.items.map((item) => item.path)).toEqual(['src/router.ts', 'src/util.ts']);
    expect(resolved.items[0].reason).toBe('symbol: buildRouter');
    const rules = await context.rules('src/router.ts');
    expect(rules.applied.map((rule) => rule.path)).toEqual(expect.arrayContaining(['AGENTS.md', '.cursor/rules/typescript.mdc']));
    context.close();
  });
});
