import { chmodSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function ensureNodePtySpawnHelperExecutable(appRoot, platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return { changed: false, path: null };

  const helperPath = join(appRoot, 'node_modules', 'node-pty', 'prebuilds', `${platform}-${arch}`, 'spawn-helper');
  if (!existsSync(helperPath)) return { changed: false, path: helperPath };

  const mode = statSync(helperPath).mode & 0o777;
  if ((mode & 0o111) !== 0) return { changed: false, path: helperPath };

  chmodSync(helperPath, mode | 0o111);
  return { changed: true, path: helperPath };
}
