import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

/** Trusted Node inspector adapter used by the standalone debug panel. */
export function createDebugManager(initialWorkspaceRoot) {
  let workspaceRoot = resolve(initialWorkspaceRoot);
  const sessions = new Map();

  return {
    setWorkspaceRoot(root) { workspaceRoot = resolve(root); },
    async launch(config) {
      if (config?.type !== 'node') throw new Error('This standalone build currently supports the Node debug adapter.');
      if (typeof config.program !== 'string' || !config.program.trim()) throw new Error('A Node program path is required.');
      const program = await confined(config.program);
      if (!(await stat(program)).isFile()) throw new Error('Debug program must be a file.');
      const cwd = config.cwd ? await confined(config.cwd) : workspaceRoot;
      const args = Array.isArray(config.args) && config.args.every((arg) => typeof arg === 'string') ? config.args : [];
      const id = randomUUID();
      const child = spawn(process.execPath, ['--inspect-brk=0', program, ...args], {
        cwd,
        env: { ...process.env, ...(config.env || {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const inspectorUrl = await waitForInspector(child);
      const session = await connectInspector({ id, child, inspectorUrl, config: { ...config, program, cwd } });
      sessions.set(id, session);
      child.once('exit', () => { session.status = 'terminated'; session.ws.close(); });
      return publicSession(session);
    },
    async control(id, command) {
      const session = requiredSession(sessions, id);
      if (command === 'disconnect') {
        session.status = 'terminated';
        session.ws.close();
        if (!session.child.killed) session.child.kill('SIGTERM');
        sessions.delete(id);
        return;
      }
      const methods = {
        continue: 'Debugger.resume', pause: 'Debugger.pause',
        'step-in': 'Debugger.stepInto', 'step-over': 'Debugger.stepOver', 'step-out': 'Debugger.stepOut',
      };
      const method = methods[command];
      if (!method) throw new Error(`Unsupported debug command: ${command}`);
      await session.send(method);
      if (command === 'pause') await waitForStatus(session, 'paused');
    },
    async stack(id) { return requiredSession(sessions, id).frames; },
    async variables(id, reference) {
      const session = requiredSession(sessions, id);
      const objectId = session.references.get(Number(reference) || session.defaultReference);
      if (!objectId) return [];
      const result = await session.send('Runtime.getProperties', { objectId, ownProperties: true, generatePreview: true });
      return (result.result || []).filter((item) => item.enumerable !== false).slice(0, 500).map((item) => {
        const value = item.value?.description !== undefined
          ? String(item.value.description)
          : item.value?.value !== undefined ? String(item.value.value) : 'undefined';
        return {
          name: item.name, value, type: item.value?.type,
          variablesReference: item.value?.objectId ? session.addReference(item.value.objectId) : undefined,
        };
      });
    },
    close() {
      for (const session of sessions.values()) {
        session.ws.close();
        if (!session.child.killed) session.child.kill('SIGTERM');
      }
      sessions.clear();
    },
  };

  async function confined(value) {
    const candidate = resolve(isAbsolute(value) ? value : resolve(workspaceRoot, value));
    const actual = await realpath(candidate);
    if (actual !== workspaceRoot && !actual.startsWith(`${workspaceRoot}${sep}`)) throw new Error('Debug path escapes the approved workspace.');
    return actual;
  }
}

async function waitForInspector(child) {
  return new Promise((resolvePromise, reject) => {
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Node inspector startup timed out.')); }, 10_000);
    const onData = (chunk) => {
      stderr += String(chunk);
      const url = stderr.match(/ws:\/\/[^\s]+/)?.[0];
      if (!url) return;
      clearTimeout(timer);
      child.stderr.off('data', onData);
      resolvePromise(url);
    };
    child.stderr.on('data', onData);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { if (!stderr.match(/ws:\/\//)) { clearTimeout(timer); reject(new Error(`Debug program exited before inspector connection (${code}).`)); } });
  });
}

async function connectInspector({ id, child, inspectorUrl, config }) {
  const ws = new WebSocket(inspectorUrl);
  await new Promise((resolvePromise, reject) => { ws.addEventListener('open', resolvePromise, { once: true }); ws.addEventListener('error', () => reject(new Error('Could not connect to Node inspector.')), { once: true }); });
  const session = {
    id, child, ws, config, status: 'running', frames: [], references: new Map(), defaultReference: 0,
    nextId: 1, nextReference: 1, pending: new Map(),
    send(method, params = {}) {
      const requestId = this.nextId++;
      return new Promise((resolvePromise, reject) => {
        this.pending.set(requestId, { resolve: resolvePromise, reject });
        this.ws.send(JSON.stringify({ id: requestId, method, params }));
      });
    },
    addReference(objectId) {
      const reference = this.nextReference++;
      this.references.set(reference, objectId);
      return reference;
    },
  };
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && session.pending.has(message.id)) {
      const pending = session.pending.get(message.id); session.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result || {});
      return;
    }
    if (message.method === 'Debugger.paused') {
      session.status = 'paused';
      session.references.clear(); session.nextReference = 1; session.defaultReference = 0;
      session.frames = (message.params?.callFrames || []).map((frame, index) => {
        for (const scope of frame.scopeChain || []) {
          if (scope.object?.objectId) {
            const reference = session.addReference(scope.object.objectId);
            if (!session.defaultReference) session.defaultReference = reference;
          }
        }
        return { id: index + 1, name: frame.functionName || '(anonymous)', source: frame.url?.replace(/^file:\/\//, '') || config.program, line: frame.location.lineNumber + 1, column: frame.location.columnNumber + 1 };
      });
    } else if (message.method === 'Debugger.resumed') {
      session.status = 'running'; session.frames = [];
    }
  });
  ws.addEventListener('close', () => {
    for (const pending of session.pending.values()) pending.reject(new Error('Inspector connection closed.'));
    session.pending.clear();
  });
  await session.send('Runtime.enable');
  await session.send('Debugger.enable');
  await session.send('Runtime.runIfWaitingForDebugger');
  return session;
}

function requiredSession(sessions, id) {
  const session = sessions.get(id);
  if (!session) throw new Error('Debug session not found.');
  return session;
}

function publicSession(session) {
  return { id: session.id, config: session.config, status: session.status };
}

async function waitForStatus(session, status) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (session.status === status) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`Debug session did not reach ${status}.`);
}
