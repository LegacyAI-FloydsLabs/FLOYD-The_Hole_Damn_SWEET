import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';

const runs = Math.max(1, Math.min(10, Number(process.env.CURSEM_STARTUP_RUNS) || 3));
const workspace = resolve(process.env.CURSEM_BENCHMARK_WORKSPACE || process.cwd());
const results = [];
for (let index = 0; index < runs; index += 1) results.push(await measure(index + 1));
const durations = results.map((result) => result.readyMs).sort((left, right) => left - right);
const summary = {
  benchmark: 'cursem-loopback-ready', runs, workspace,
  medianMs: durations[Math.floor(durations.length / 2)], minMs: durations[0], maxMs: durations.at(-1), results,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

async function measure(run) {
  const startedAt = performance.now();
  const child = spawn(process.execPath, ['server/cursem-server.mjs', '--workspace', workspace], {
    cwd: process.cwd(), env: { ...process.env, CURSEM_PORT: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const url = await waitForUrl(child, () => stdout, () => stderr);
    const health = await fetch(`${url}api/health`, { signal: AbortSignal.timeout(2_000) });
    const index = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    if (!health.ok || !index.ok) throw new Error(`Runtime probe failed: health=${health.status} index=${index.status}`);
    return { run, readyMs: Math.round(performance.now() - startedAt), health: health.status, index: index.status };
  } finally {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolvePromise) => child.once('exit', resolvePromise)), new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

async function waitForUrl(child, stdout, stderr) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const match = stdout().match(/CURSEM IDE listening on (http:\/\/127\.0\.0\.1:\d+\/)/);
    if (match) return match[1];
    if (child.exitCode !== null) throw new Error(`CURSEM exited with ${child.exitCode}: ${stderr()}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`CURSEM did not become ready within 20 seconds: ${stderr()}`);
}
