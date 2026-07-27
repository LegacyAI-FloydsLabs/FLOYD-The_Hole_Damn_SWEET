import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

const LANGUAGE_CONFIG = Object.freeze({
  typescript: ['typescript-language-server', ['--stdio']],
  javascript: ['typescript-language-server', ['--stdio']],
  javascriptreact: ['typescript-language-server', ['--stdio']],
  typescriptreact: ['typescript-language-server', ['--stdio']],
  json: ['vscode-json-language-server', ['--stdio']],
  html: ['vscode-html-language-server', ['--stdio']],
  css: ['vscode-css-language-server', ['--stdio']],
  python: ['pyright-langserver', ['--stdio']],
  shell: ['bash-language-server', ['start']],
  rust: ['rust-analyzer', []],
});

/**
 * Shared language-server supervisor.
 *
 * One stdio process is retained per language, regardless of open editor tabs.
 * Browser WebSockets carry plain JSON-RPC; this bridge adds/removes LSP's
 * Content-Length framing and terminates both sockets and child processes when
 * the IDE server shuts down.
 */
export function createLspGateway({ server, workspaceRoot, appRoot }) {
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Map();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const match = url.pathname.match(/^\/ws\/lsp\/([a-z]+)$/);
    if (!match) return;
    const remote = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (remote !== '127.0.0.1' && remote !== '::1') { socket.destroy(); return; }
    const languageId = match[1];
    if (!LANGUAGE_CONFIG[languageId]) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => attach(languageId, ws));
  });

  function attach(languageId, ws) {
    let session;
    try { session = getSession(languageId); }
    catch (error) { ws.close(1011, error.message); return; }
    session.clients.add(ws);
    ws.on('message', (data) => session.write(String(data)));
    ws.on('close', () => session.clients.delete(ws));
    ws.on('error', () => session.clients.delete(ws));
  }

  function getSession(languageId) {
    const family = languageFamily(languageId);
    const current = sessions.get(family);
    if (current?.alive) return current;
    const config = LANGUAGE_CONFIG[languageId];
    const command = resolveCommand(config[0], appRoot);
    if (!command) throw new Error(`${config[0]} is not installed.`);
    const child = spawn(command, config[1], { cwd: workspaceRoot, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const session = {
      languageId, family, command, child, clients: new Set(), alive: true, error: null,
      buffer: Buffer.alloc(0), expected: null,
      write(json) {
        if (!this.alive || !this.child.stdin.writable) return;
        const body = Buffer.from(json);
        this.child.stdin.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
        this.child.stdin.write(body);
      },
      stop() {
        this.alive = false;
        for (const client of this.clients) client.close(1012, 'Language server restarting');
        this.clients.clear();
        if (!this.child.killed) this.child.kill('SIGTERM');
      },
    };
    child.stdout.on('data', (chunk) => consume(session, chunk));
    child.stderr.on('data', (chunk) => { session.error = String(chunk).trim().slice(-2000); });
    child.on('error', (error) => { session.error = error.message; session.alive = false; });
    child.on('exit', (code) => {
      session.alive = false;
      if (code && !session.error) session.error = `Exited with code ${code}`;
      for (const client of session.clients) client.close(1011, 'Language server exited');
      session.clients.clear();
    });
    sessions.set(family, session);
    return session;
  }

  function consume(session, chunk) {
    session.buffer = Buffer.concat([session.buffer, chunk]);
    while (true) {
      if (session.expected === null) {
        const boundary = session.buffer.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        const header = session.buffer.subarray(0, boundary).toString('ascii');
        const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1]);
        session.buffer = session.buffer.subarray(boundary + 4);
        if (!Number.isInteger(length) || length < 0 || length > 16 * 1024 * 1024) { session.stop(); return; }
        session.expected = length;
      }
      if (session.buffer.byteLength < session.expected) return;
      const payload = session.buffer.subarray(0, session.expected).toString('utf8');
      session.buffer = session.buffer.subarray(session.expected);
      session.expected = null;
      for (const client of session.clients) if (client.readyState === 1) client.send(payload);
    }
  }

  return {
    list() {
      return Object.keys(LANGUAGE_CONFIG).map((languageId) => ({ languageId, name: LANGUAGE_CONFIG[languageId][0], version: resolveCommand(LANGUAGE_CONFIG[languageId][0], appRoot) ? 'installed' : undefined }));
    },
    health(languageId) {
      const session = sessions.get(languageFamily(languageId));
      return { languageId, status: session?.alive ? 'running' : session?.error ? 'error' : 'stopped', ...(session?.child.pid ? { pid: session.child.pid } : {}), ...(session?.error ? { lastError: session.error } : {}) };
    },
    restart(languageId) {
      sessions.get(languageFamily(languageId))?.stop();
      sessions.delete(languageFamily(languageId));
      getSession(languageId);
    },
    close() {
      for (const session of sessions.values()) session.stop();
      sessions.clear();
      wss.close();
    },
  };
}

function languageFamily(languageId) {
  return ['typescript', 'javascript', 'javascriptreact', 'typescriptreact'].includes(languageId) ? 'typescript' : languageId;
}

function resolveCommand(command, appRoot) {
  const local = join(appRoot, 'node_modules/.bin', command);
  if (existsSync(local)) return local;
  const path = String(process.env.PATH || '').split(':').map((entry) => join(entry, command)).find(existsSync);
  return path || null;
}
