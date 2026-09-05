import { execFileSync } from 'node:child_process';
import { readFile, rename, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function registerUserAgent({ label, candidate, target, uid }, {
  run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', timeout: 5000 }),
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (!/^com\.floyd\.(frame|core)$/.test(label) || !/^\d+$/.test(String(uid))) throw new Error('Invalid FLOYD service identity');
  if (dirname(resolve(candidate)) !== dirname(resolve(target))) throw new Error('Service candidate must be beside its target');
  const domain = `gui/${uid}`;
  const service = `${domain}/${label}`;
  run('/usr/bin/plutil', ['-lint', candidate]);
  let previous;
  try { previous = await readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous?.equals(await readFile(candidate))) {
    try {
      run('/bin/launchctl', ['print', service]);
      await unlink(candidate);
      return { changed: false };
    } catch { /* A matching file without a loaded service still needs startup. */ }
  }
  const backup = `${target}.previous`;
  if (previous) await writeFile(backup, previous, { mode: 0o600 });
  const bootstrap = async () => {
    let last;
    // bootout returns before launchd always finishes releasing the old job.
    // Error 5 during that short transition is retried; other errors fail now.
    for (let attempt = 0; attempt < 20; attempt++) {
      try { run('/bin/launchctl', ['bootstrap', domain, target]); return; }
      catch (error) { last = error; if (error.status !== 5) throw error; }
      await pause(500);
    }
    throw last;
  };
  await rename(candidate, target);
  try { run('/bin/launchctl', ['bootout', service]); } catch { /* Not loaded on first install. */ }
  try { await bootstrap(); }
  catch (error) {
    if (previous) {
      await writeFile(target, previous, { mode: 0o600 });
      try { await bootstrap(); }
      catch (recovery) { throw new AggregateError([error, recovery], `Service failed; previous settings are preserved at ${backup}`); }
    } else { await unlink(target); }
    throw new Error(`Could not start ${label}; previous service settings restored`, { cause: error });
  }
  return { changed: true, backup: previous ? backup : null };
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  try {
    const [label, candidate, target] = process.argv.slice(2);
    const result = await registerUserAgent({ label, candidate, target, uid: process.getuid() });
    console.log(`${label}: ${result.changed ? 'registered' : 'already running'}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
