import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostGateway } from '@/platform';
import { TerminalOneAdapter } from '@/terminal/TerminalOneAdapter';
import serverSource from '../vendor/TerminalOne/src/server.js?raw';

vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly protocols?: string[];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string, protocols?: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

const gateway = {
  terminalAuth: vi.fn(async () => ({
    token: 'floyd-terminal-token',
    endpoint: 'ws://floyd.test/terminal',
    expiresAt: Date.now() + 60_000,
  })),
} as unknown as HostGateway;

describe('TerminalOneAdapter protocol', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('uses TerminalOne shell, output, input, and close messages', async () => {
    const adapter = new TerminalOneAdapter(gateway);
    const sessionPromise = adapter.createSession('/workspace', 120, 40);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    const socket = FakeWebSocket.instances[0];
    expect(socket.protocols).toEqual(['floyd-terminal-token']);
    socket.open();
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: 'shell',
      cols: 120,
      rows: 40,
      cwd: '/workspace',
    });

    socket.receive({ type: 'ready', sessionId: 'session-1', cwd: '/workspace' });
    await expect(sessionPromise).resolves.toMatchObject({ id: 'session-1', status: 'connected' });

    const output = vi.fn();
    adapter.onOutput('session-1', output);
    socket.receive({ type: 'output', data: 'terminal output' });
    expect(output).toHaveBeenCalledWith('terminal output');

    adapter.sendInput('session-1', 'pwd\r');
    await vi.waitFor(() => {
      expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ type: 'input', data: 'pwd\r' });
    });

    adapter.killSession('session-1');
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: 'close' });
  });

  it('resumes an existing TerminalOne session with the real resume message', async () => {
    const adapter = new TerminalOneAdapter(gateway);
    adapter.registerSession('session-2', '/workspace');

    const resumePromise = adapter.resumeSession('session-2', 90, 30);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.open();

    expect(JSON.parse(socket.sent[0])).toEqual({
      type: 'resume',
      sessionId: 'session-2',
      cols: 90,
      rows: 30,
    });

    socket.receive({ type: 'ready', sessionId: 'session-2', cwd: '/workspace' });
    await expect(resumePromise).resolves.toMatchObject({ id: 'session-2', status: 'connected' });
  });

  it('discovers recoverable sessions from TerminalOne admin endpoint', async () => {
    const sessions = [
      {
        id: 'admin-session-1',
        command: '/bin/zsh',
        attached: false,
        resumable: true,
        processExited: false,
      },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ sessions }),
    }) as unknown as Response));

    const adapter = new TerminalOneAdapter(gateway);
    const discovered = await adapter.discoverSessions('/workspace');

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toEqual({
      id: 'admin-session-1',
      title: 'zsh',
      cwd: '/workspace',
      status: 'disconnected',
      resumable: true,
      attached: false,
    });

    const listed = adapter.listSessions();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(expect.objectContaining({ id: 'admin-session-1', resumable: true, attached: false }));

    expect(vi.mocked(fetch)).toHaveBeenCalledWith('http://floyd.test/admin/sessions', expect.objectContaining({ method: 'GET' }));
  });

  it('stays aligned with the copied TerminalOne server dispatcher', () => {
    for (const messageType of ['shell', 'resume', 'input', 'resize', 'close']) {
      expect(serverSource).toContain(`case '${messageType}'`);
    }
    expect(serverSource).toContain("type: 'output'");
    expect(serverSource).toContain("type: 'ready'");
  });
});
