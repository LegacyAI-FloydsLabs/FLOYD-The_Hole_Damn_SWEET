// @vitest-environment node
// === Tests: cli/cursem.mjs (in-shell control CLI) ==========================
import { describe, expect, it } from 'vitest';
import { EXIT, GROUPS, parseCli, parseFileTarget, runCli } from '../cli/cursem.mjs';

/** Build a dependency-injected io harness. `responder` maps {method, args} →
 *  {result}|{error}. */
function makeIo(responder, env = {}) {
  const requests = [];
  const stdout = [];
  const stderr = [];
  const io = {
    env: { CURSEM_API: 'http://127.0.0.1:13012/api/control', CURSEM_TOKEN: 'token', ...env },
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    fetchImpl: async (url, init) => {
      const { method, args } = JSON.parse(init.body);
      requests.push({ url, method, args, authorization: init.headers.authorization });
      const reply = responder({ method, args });
      return {
        ok: true,
        status: 200,
        json: async () => (reply.error ? { error: reply.error } : { result: reply.result ?? null }),
      };
    },
  };
  return { io, requests, stdout, stderr };
}

describe('cursem CLI parsing', () => {
  it('covers the complete v1 verb surface', () => {
    expect(Object.keys(GROUPS.terminal)).toEqual(['read', 'type', 'press']);
    expect(Object.keys(GROUPS.editor)).toEqual(['open']);
    expect(Object.keys(GROUPS.surface)).toEqual(['list', 'focus', 'close', 'set-title']);
    expect(Object.keys(GROUPS.ui)).toEqual(['notify']);
    expect(GROUPS.browser).toBeUndefined();
  });

  it('splits path:line:col only from trailing digits', () => {
    expect(parseFileTarget('src/a.ts:12:3')).toEqual({ path: 'src/a.ts', line: 12, column: 3 });
    expect(parseFileTarget('src/a.ts:12')).toEqual({ path: 'src/a.ts', line: 12, column: undefined });
    expect(parseFileTarget('src/a.ts')).toEqual({ path: 'src/a.ts', line: undefined, column: undefined });
    expect(parseFileTarget('C:\\work\\a.ts:4')).toEqual({ path: 'C:\\work\\a.ts', line: 4, column: undefined });
    expect(parseFileTarget('/abs/dir:with colon/file.txt')).toEqual({ path: '/abs/dir:with colon/file.txt', line: undefined, column: undefined });
  });

  it('parses flags and positionals', () => {
    const { flags, group, verb, positionals } = parseCli(['terminal', 'type', '--panel', 'abc123', 'ls', '-la']);
    expect(group).toBe('terminal');
    expect(verb).toBe('type');
    expect(flags.panel).toBe('abc123');
    expect(positionals).toEqual(['ls', '-la']);
  });
});

describe('cursem CLI transport and exit codes', () => {
  it('exits 3 with an enable hint when the env channel is missing', async () => {
    const { io, stderr } = makeIo(() => ({}), { CURSEM_API: '', CURSEM_TOKEN: '' });
    const code = await runCli(['version'], io);
    expect(code).toBe(EXIT.ENV);
    expect(stderr.join('\n')).toContain('CURSEM_API/CURSEM_TOKEN');
  });

  it('version prints the host API version integer with a bearer POST', async () => {
    const { io, requests, stdout } = makeIo(() => ({ result: { version: 1 } }));
    const code = await runCli(['version'], io);
    expect(code).toBe(EXIT.OK);
    expect(stdout).toEqual(['1']);
    expect(requests[0].url).toBe('http://127.0.0.1:13012/api/control/invoke');
    expect(requests[0].method).toBe('cursem.version');
    expect(requests[0].authorization).toBe('Bearer token');
  });

  it('--json prints the raw result as one line', async () => {
    const { io, stdout } = makeIo(() => ({ result: { version: 1 } }));
    await runCli(['--json', 'version'], io);
    expect(stdout).toEqual(['{"version":1}']);
  });

  it('maps remote errors to exit 1 with the stable code', async () => {
    const { io, stderr } = makeIo(() => ({ error: { code: 'permission-denied', message: 'Denied by Settings → CLI.' } }));
    const code = await runCli(['version'], io);
    expect(code).toBe(EXIT.API);
    expect(stderr[0]).toContain('permission-denied');
  });

  it('maps transport failures to exit 3', async () => {
    const io = {
      env: { CURSEM_API: 'http://127.0.0.1:1/api/control', CURSEM_TOKEN: 't' },
      stdout: () => {},
      stderr: () => {},
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    };
    expect(await runCli(['version'], io)).toBe(EXIT.ENV);
  });

  it('exits 2 on usage errors (type without --panel)', async () => {
    const { io, requests } = makeIo(() => ({}));
    const code = await runCli(['terminal', 'type', 'ls'], io);
    expect(code).toBe(EXIT.USAGE);
    expect(requests).toEqual([]);
  });
});

describe('cursem CLI verbs', () => {
  it('editor open sends the parsed target and prints the short surface id', async () => {
    const { io, requests, stdout } = makeIo(({ method }) =>
      method === 'cursem.editor.openFile' ? { result: { id: 'editor:/ws/src/a.ts' } } : {});
    const code = await runCli(['editor', 'open', 'src/a.ts:12:3'], io);
    expect(code).toBe(EXIT.OK);
    expect(requests[0].args).toEqual({ path: 'src/a.ts', line: 12, column: 3 });
    expect(stdout).toEqual(['editor:/']);
  });

  it('surface list formats one line per surface with the focused marker', async () => {
    const { io, stdout } = makeIo(() => ({
      result: {
        surfaces: [
          { id: 'editor:/ws/a.ts', type: 'editor', title: 'a.ts', focused: false },
          { id: 'terminal:abcdef123456', type: 'terminal', title: 'terminal 1', focused: true },
        ],
      },
    }));
    await runCli(['surface', 'list'], io);
    expect(stdout[0].split('\n')).toEqual([
      '  editor:/ editor a.ts',
      '* terminal terminal terminal 1',
    ]);
  });

  it('resolves unique id prefixes client-side before mutating verbs', async () => {
    const { io, requests } = makeIo(({ method }) => {
      if (method === 'cursem.surface.list') {
        return { result: { surfaces: [{ id: 'terminal:abcdef123456', type: 'terminal', title: 't', focused: true }] } };
      }
      return { result: { ok: true } };
    });
    const code = await runCli(['terminal', 'type', '--panel', 'terminal:abc', 'echo hi'], io);
    expect(code).toBe(EXIT.OK);
    expect(requests[1].method).toBe('cursem.terminal.type');
    expect(requests[1].args).toEqual({ targetId: 'terminal:abcdef123456', text: 'echo hi' });
  });

  it('rejects ambiguous prefixes as usage errors', async () => {
    const { io, stderr } = makeIo(() => ({
      result: {
        surfaces: [
          { id: 'terminal:aaaa1111', type: 'terminal', title: 'a', focused: true },
          { id: 'terminal:aaaa2222', type: 'terminal', title: 'b', focused: false },
        ],
      },
    }));
    const code = await runCli(['surface', 'close', 'terminal:aaaa'], io);
    expect(code).toBe(EXIT.USAGE);
    expect(stderr[0]).toContain('ambiguous');
  });

  it('set-title self-addresses via CURSEM_TERMINAL_ID', async () => {
    const { io, requests } = makeIo(() => ({ result: { ok: true } }), { CURSEM_TERMINAL_ID: 'term-self-1' });
    const code = await runCli(['surface', 'set-title', 'build', 'server'], io);
    expect(code).toBe(EXIT.OK);
    expect(requests[0].method).toBe('cursem.surface.setTitle');
    expect(requests[0].args).toEqual({ targetId: 'term-self-1', title: 'build server' });
  });

  it('terminal read caps human output to the last 200 lines; --max 0 lifts it', async () => {
    const text = Array.from({ length: 250 }, (_, index) => `line-${index + 1}`).join('\n');
    const capped = makeIo(() => ({ result: { text } }));
    await runCli(['terminal', 'read'], capped.io);
    expect(capped.stdout[0].split('\n')).toHaveLength(200);
    expect(capped.stdout[0].startsWith('line-51')).toBe(true);

    const uncapped = makeIo(() => ({ result: { text } }));
    await runCli(['terminal', 'read', '--max', '0'], uncapped.io);
    expect(uncapped.stdout[0].split('\n')).toHaveLength(250);
  });

  it('terminal press forwards the friendly key name', async () => {
    const { io, requests } = makeIo(({ method }) =>
      method === 'cursem.surface.list'
        ? { result: { surfaces: [{ id: 'terminal:t1', type: 'terminal', title: 't', focused: true }] } }
        : { result: { ok: true } });
    await runCli(['terminal', 'press', '--panel', 'terminal:t1', 'ctrl-c'], io);
    expect(requests[1].args).toEqual({ targetId: 'terminal:t1', key: 'ctrl-c' });
  });
});
