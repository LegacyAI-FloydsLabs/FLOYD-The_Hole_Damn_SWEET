// === Tests: CLI permission matrix parity (frontend mirror vs server gate) ==
import { describe, expect, it } from 'vitest';
import {
  CLI_PERMISSION_MATRIX,
  DEFAULT_CLI_SETTINGS,
  cliPermissionForMethod,
} from '@/platform/cliPermissions';
// @ts-expect-error — the server-authoritative gate is plain ESM, no types.
import * as serverPermissions from '../server/cursem-permissions.mjs';

const {
  CLI_PERMISSION_MATRIX: SERVER_MATRIX,
  DEFAULT_CLI_SETTINGS: SERVER_DEFAULTS,
  SUPPORTED_METHODS,
  cliPermissionForMethod: serverCliPermissionForMethod,
} = serverPermissions as {
  CLI_PERMISSION_MATRIX: Array<{ id: string; label: string; read: { key: string; label: string } | null; control: { key: string; label: string } | null }>;
  DEFAULT_CLI_SETTINGS: Record<string, boolean>;
  SUPPORTED_METHODS: Set<string>;
  cliPermissionForMethod: (method: string) => { surface: string; access: string; key: string } | null;
};

describe('CLI permission matrix parity', () => {
  it('frontend defaults mirror the server defaults exactly', () => {
    expect({ ...DEFAULT_CLI_SETTINGS }).toEqual({ ...SERVER_DEFAULTS });
    // Keystroke injection ships OFF (destructive-by-default opt-in).
    expect(DEFAULT_CLI_SETTINGS.cliTerminalInputEnabled).toBe(false);
    expect(DEFAULT_CLI_SETTINGS.cliEnabled).toBe(true);
  });

  it('frontend matrix cells mirror the server matrix exactly', () => {
    const cells = (matrix: typeof SERVER_MATRIX) =>
      matrix.flatMap((surface) =>
        [surface.read, surface.control]
          .filter((cell) => cell !== null)
          .map((cell) => `${surface.id}:${cell!.key}:${cell!.label}`),
      );
    expect(cells(CLI_PERMISSION_MATRIX as unknown as typeof SERVER_MATRIX)).toEqual(cells(SERVER_MATRIX));
  });

  it('method → cell resolution matches the server gate for every supported method', () => {
    for (const method of SUPPORTED_METHODS) {
      const frontend = cliPermissionForMethod(method);
      const server = serverCliPermissionForMethod(method);
      expect(frontend?.key ?? null, method).toBe(server?.key ?? null);
      expect(frontend?.access ?? null, method).toBe(server?.access ?? null);
    }
  });

  it('unlisted verbs in a covered namespace fall into the CONTROL cell', () => {
    expect(cliPermissionForMethod('cursem.terminal.frobnicate')?.key).toBe('cliTerminalInputEnabled');
    expect(cliPermissionForMethod('cursem.surface.frobnicate')?.key).toBe('cliSurfaceControlEnabled');
  });

  it('read verbs resolve to the read cell; version is ungated', () => {
    expect(cliPermissionForMethod('cursem.terminal.read')?.access).toBe('read');
    expect(cliPermissionForMethod('cursem.surface.list')?.access).toBe('read');
    expect(cliPermissionForMethod('cursem.version')).toBeNull();
    expect(cliPermissionForMethod('cursem.browser.open')).toBeNull();
  });
});
