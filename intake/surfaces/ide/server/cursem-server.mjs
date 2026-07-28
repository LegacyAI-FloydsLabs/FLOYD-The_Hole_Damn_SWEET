import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleGateway } from './gateway-relay.mjs';
import { createStandaloneHost } from './standalone-host.mjs';
import { createLspGateway } from './lsp-gateway.mjs';
import { createDebugManager } from './debug-manager.mjs';
import { ensureNodePtySpawnHelperExecutable } from './node-pty-runtime.mjs';
import { checkCredentialProxy, resolveCredentialProxy } from './credential-proxy.mjs';

const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const staticRoot = join(appRoot, 'dist');
if (!existsSync(staticRoot)) throw new Error('dist is missing. Run npm run build first.');

try {
  const proxy = await checkCredentialProxy();
  process.stdout.write(`Credential proxy ready at ${proxy.url}${proxy.version ? ` (v${proxy.version})` : ''}; provider credentials remain outside CURSEM.\n`);
} catch (error) {
  process.stderr.write(`Credential proxy unavailable at startup: ${error instanceof Error ? error.message : 'health check failed'}. CURSEM will retry on each model request.\n`);
}

const requestedPort = parsePort(process.env.CURSEM_PORT, 0);
const workspaceArg = process.argv.indexOf('--workspace');
const workspaceRoot = workspaceArg >= 0 ? process.argv[workspaceArg + 1] : process.env.CURSEM_WORKSPACE_ROOT || process.env.INIT_CWD || process.cwd();
if (!workspaceRoot) throw new Error('--workspace requires a folder path.');

let terminalChild = null;
let terminalEndpoint = process.env.CURSEM_TERMINAL_URL || '';
let terminalToken = process.env.CURSEM_TERMINAL_TOKEN || '';
if (!terminalEndpoint) {
  ensureNodePtySpawnHelperExecutable(appRoot);
  const terminalPort = process.env.CURSEM_TERMINAL_PORT ? parsePort(process.env.CURSEM_TERMINAL_PORT) : await reservePort();
  terminalToken = terminalToken || randomBytes(24).toString('base64url');
  terminalEndpoint = `ws://127.0.0.1:${terminalPort}`;
  terminalChild = spawn(process.execPath, [join(appRoot, 'vendor/TerminalOne/src/server.js')], {
    cwd: join(appRoot, 'vendor/TerminalOne'),
    env: { ...process.env, PORT: String(terminalPort), TERMINALONE_AUTH_TOKEN: terminalToken },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  terminalChild.once('error', (error) => process.stderr.write(`TerminalOne failed to start: ${error.message}\n`));
  await waitForTerminal(terminalPort, terminalChild);
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

// Embedding policy: standalone CURSEM refuses all framing, but a host shell
// (the FLOYD frame) may allowlist its own origins via CURSEM_FRAME_ANCESTORS
// (space-separated origins). Anything else still gets 'none'.
const frameAncestors = (process.env.CURSEM_FRAME_ANCESTORS || '')
  .split(/\s+/)
  .filter((origin) => /^https?:\/\/[\w.-]+(:\d+)?$/.test(origin));
const frameAncestorsDirective = frameAncestors.length ? frameAncestors.join(' ') : "'none'";

let standalone;
const server = http.createServer(async (req, res) => {
  if (req.url === '/gateway' || req.url?.startsWith('/gateway?')) return handleGateway(req, res, { resolveCredentialProxy });
  if (req.url === '/api/vault/catalog' && req.method === 'GET') {
    try {
      const upstream = await fetch(`${process.env.FLOYD_FRAME_URL || 'http://127.0.0.1:13030'}/api/vault/catalog`, {
        signal: AbortSignal.timeout(2_000),
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') || 'application/json',
        'content-length': body.byteLength,
        'cache-control': 'no-store',
      });
      return res.end(body);
    } catch {
      res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: 'Vault catalog unavailable' }));
    }
  }
  if (req.url?.startsWith('/api/')) return standalone.handle(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return; }
  const pathname = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
  const candidate = resolve(staticRoot, normalize(pathname.slice(1) || 'index.html'));
  const file = candidate.startsWith(`${staticRoot}/`) && existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(staticRoot, 'index.html');
  res.writeHead(200, {
    'content-type': contentTypes[extname(file)] || 'application/octet-stream',
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': `default-src 'self'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-eval'; connect-src 'self' ws://127.0.0.1:*; object-src 'none'; frame-ancestors ${frameAncestorsDirective}; base-uri 'self'`,
  });
  if (req.method === 'HEAD') res.end(); else createReadStream(file).pipe(res);
});

const lspManager = createLspGateway({ server, workspaceRoot: resolve(workspaceRoot), appRoot });
const debugManager = createDebugManager(resolve(workspaceRoot));
standalone = await createStandaloneHost({ initialWorkspaceRoot: workspaceRoot, terminalEndpoint, terminalToken, lspManager, debugManager });

server.listen(requestedPort, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;
  process.stdout.write(`CURSEM IDE listening on http://127.0.0.1:${port}/\nWorkspace: ${standalone.workspaceRoot}\n`);
});

let shuttingDown = false;
let parentWatch = null;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  standalone.close();
  terminalChild?.kill('SIGTERM');
  if (parentWatch) clearInterval(parentWatch);
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

const packagedParentPid = Number(process.env.CURSEM_PARENT_PID);
if (Number.isInteger(packagedParentPid) && packagedParentPid > 1) {
  parentWatch = setInterval(() => {
    try { process.kill(packagedParentPid, 0); }
    catch { shutdown(); }
  }, 1_000);
  parentWatch.unref();
}

function parsePort(value, fallback) {
  if ((value === undefined || value === '') && fallback !== undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer between 1 and 65535.');
  return port;
}

async function reservePort() {
  const probe = http.createServer();
  await new Promise((resolvePromise, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolvePromise) => probe.close(resolvePromise));
  return port;
}

async function waitForTerminal(port, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`TerminalOne exited during startup with code ${child.exitCode}.`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch { /* keep polling during native module startup */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  child.kill('SIGTERM');
  throw new Error('TerminalOne did not become healthy within 15 seconds.');
}
