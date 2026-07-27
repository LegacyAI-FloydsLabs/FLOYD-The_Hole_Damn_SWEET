import { beforeEach, describe, expect, it } from 'vitest';
import { FileSystemService } from '@/workspace/FileSystemService';
import { MockHostGateway } from '@/platform/host';

describe('FileSystemService workspace discovery', () => {
  let gateway: MockHostGateway;
  let service: FileSystemService;

  beforeEach(() => {
    localStorage.clear();
    gateway = new MockHostGateway({ workspaceRoot: '/test/workspace' });
    gateway.setFile('/test/workspace/src/main.ts', 'const signal = "floyd";\n');
    gateway.setFile('/test/workspace/src/panel.tsx', 'export function Panel() {}\n');
    gateway.setFile('/test/workspace/README.md', '# CURSEM\nFloyd workbench\n');
    gateway.setFile('/test/workspace/node_modules/ignored.js', 'floyd\n');
    gateway.setFile('/test/workspace/dogfood-output/report.md', 'floyd generated evidence\n');
    gateway.setFile('/test/workspace/test-results/cursem-smoke-results.json', '{"screen":"floyd"}\n');
    gateway.setFile('/test/workspace/reports/ui-smoke.json', '{"screen":"floyd"}\n');
    service = new FileSystemService(gateway, '/test/workspace');
  });

  it('walks real workspace files and excludes generated dependency trees', async () => {
    const paths = (await service.walkFiles()).map((entry) => entry.path);
    expect(paths).toContain('/test/workspace/src/main.ts');
    expect(paths).toContain('/test/workspace/README.md');
    expect(paths).not.toContain('/test/workspace/node_modules/ignored.js');
    expect(paths).not.toContain('/test/workspace/dogfood-output/report.md');
    expect(paths).not.toContain('/test/workspace/test-results/cursem-smoke-results.json');
    expect(paths).not.toContain('/test/workspace/reports/ui-smoke.json');
  });

  it('searches file names and text contents with line receipts', async () => {
    const results = await service.searchWorkspace('floyd');
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/test/workspace/src/main.ts', line: 1 }),
      expect.objectContaining({ path: '/test/workspace/README.md', line: 2 }),
    ]));
    expect(results.map((result) => result.path)).not.toContain('/test/workspace/dogfood-output/report.md');
    expect(results.map((result) => result.path)).not.toContain('/test/workspace/test-results/cursem-smoke-results.json');
    expect(results.map((result) => result.path)).not.toContain('/test/workspace/reports/ui-smoke.json');
  });

  it('persists and clears recoverable unsaved buffers', () => {
    service.saveBuffer('/test/workspace/src/main.ts', 'dirty');
    expect(service.recoverBuffer('/test/workspace/src/main.ts')).toBe('dirty');
    service.clearBuffer('/test/workspace/src/main.ts');
    expect(service.recoverBuffer('/test/workspace/src/main.ts')).toBeNull();
  });
});
