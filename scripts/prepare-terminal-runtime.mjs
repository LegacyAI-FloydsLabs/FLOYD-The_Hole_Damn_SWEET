import { chmod, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyPty(project) {
  const require = createRequire(join(project, 'package.json'));
  const pty = require('node-pty');
  await new Promise((resolve, reject) => {
    const child = pty.spawn('/bin/sh', ['-c', "printf 'FLOYD-PTY-%s\\n' 42"], {
      name: 'xterm', cols: 80, rows: 24, cwd: tmpdir(),
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Terminal shell timed out: ${project}`)); }, 5000);
    child.onData(data => { output += data; });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode === 0 && output.includes('FLOYD-PTY-42')) resolve();
      else reject(new Error(`Terminal shell failed (${exitCode}): ${project}: ${output}`));
    });
  });
}

export async function prepareTerminalRuntime(root, { platform = process.platform, arch = process.arch, smoke = verifyPty } = {}) {
  if (platform !== 'darwin' || arch !== 'arm64') throw new Error('The FLOYD installer targets macOS arm64');
  for (const surface of ['ide', 'launcher', 'pty']) {
    const project = join(root, 'intake/surfaces', surface);
    const helper = join(project, 'node_modules/node-pty/prebuilds', `${platform}-${arch}`, 'spawn-helper');
    if (!(await stat(helper)).isFile()) throw new Error(`Terminal helper is not a file: ${helper}`);
    // node-pty's prebuilt helper can arrive as 0644 after npm ci/prune.
    // Fix the clean build input, never an installed read-only application.
    await chmod(helper, 0o755);
    await smoke(project);
    console.log(`FLOYD_PTY PASS ${surface}`);
  }
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  try { await prepareTerminalRuntime(process.argv[2]); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
