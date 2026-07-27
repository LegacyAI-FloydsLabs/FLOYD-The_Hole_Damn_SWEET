import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTaskDiscovery } from '../server/task-discovery.mjs';

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('workspace task discovery', () => {
  it('discovers package, Python, Make, and safe VS Code task vectors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cursem-tasks-')); roots.push(root);
    await mkdir(join(root, '.vscode'), { recursive: true });
    await mkdir(join(root, 'tests'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', dev: 'vite' } }));
    await writeFile(join(root, 'Makefile'), 'check:\n\t@true\n.PHONY: check\n');
    await writeFile(join(root, '.vscode', 'tasks.json'), `{"tasks":[
      {"label":"safe","type":"process","command":"go","args":["test","./..."]},
      {"label":"unsafe","type":"shell","command":"sh","args":["-c","curl bad"]},
      {"label":"substitution","type":"process","command":"npm","args":["run","${'${input:name}'}"]},
    ]}`);
    const tasks = await createTaskDiscovery({ workspaceRoot: root }).list();
    expect(tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'package:test', executable: 'npm', args: ['run', 'test'], kind: 'test' }),
      expect.objectContaining({ id: 'pytest', executable: 'pytest' }),
      expect.objectContaining({ id: 'make:check', executable: 'make', args: ['check'] }),
      expect.objectContaining({ label: 'safe', executable: 'go', args: ['test', './...'] }),
    ]));
    expect(tasks.some((item) => item.label === 'unsafe' || item.label === 'substitution')).toBe(false);
  });

  it('switches roots without retaining stale tasks', async () => {
    const first = await mkdtemp(join(tmpdir(), 'cursem-tasks-a-')), second = await mkdtemp(join(tmpdir(), 'cursem-tasks-b-')); roots.push(first, second);
    await writeFile(join(first, 'Cargo.toml'), '[package]\nname="fixture"');
    await writeFile(join(second, 'go.mod'), 'module example.test');
    const discovery = createTaskDiscovery({ workspaceRoot: first });
    expect((await discovery.list()).some((task) => task.id === 'cargo:test')).toBe(true);
    discovery.setWorkspaceRoot(second);
    const tasks = await discovery.list();
    expect(tasks.some((task) => task.id === 'cargo:test')).toBe(false);
    expect(tasks.some((task) => task.id === 'go:test')).toBe(true);
  });
});
