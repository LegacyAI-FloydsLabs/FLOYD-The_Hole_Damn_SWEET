// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDebugManager } from '../server/debug-manager.mjs';

describe('standalone Node debug adapter', () => {
  it('launches inside the workspace and supports pause, stack, variables, continue, and disconnect', { timeout: 20_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'cursem-debug-'));
    const program = join(root, 'debug.js');
    await writeFile(program, 'const visible = 42;\nsetInterval(() => { globalThis.tick = visible; }, 20);\n');
    const manager = createDebugManager(root);
    try {
      const session = await manager.launch({ name: 'Fixture', type: 'node', request: 'launch', program, cwd: root, projectId: 'fixture' });
      expect(session).toMatchObject({ id: expect.any(String), status: 'running' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await manager.control(session.id, 'pause');
      const frames = await manager.stack(session.id);
      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0]).toMatchObject({ id: expect.any(Number), line: expect.any(Number), column: expect.any(Number) });
      expect(await manager.variables(session.id)).toEqual(expect.any(Array));
      await manager.control(session.id, 'continue');
      await manager.control(session.id, 'disconnect');
    } finally {
      manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
