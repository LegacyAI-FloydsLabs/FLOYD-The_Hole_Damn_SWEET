import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const manifestPath = 'Contents/Resources/payload-manifest.json';

function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function entries(root, directory = root) {
  const result = {};
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const key = relative(root, path).split(sep).join('/');
    if (key === manifestPath) continue;
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      const target = await readlink(path);
      if (!inside(root, resolve(dirname(path), target))) throw new Error(`Link leaves application: ${key}`);
      const resolved = await realpath(path);
      if (!inside(root, resolved)) throw new Error(`Link resolves outside application: ${key}`);
      result[key] = { link: target };
    } else if (stat.isDirectory()) {
      if ((stat.mode & 0o555) !== 0o555) throw new Error(`Package directory is not readable by every Mac user: ${key}`);
      Object.assign(result, await entries(root, path));
    } else if (stat.isFile()) {
      if ((stat.mode & 0o444) !== 0o444) throw new Error(`Package file is not readable by every Mac user: ${key}`);
      if ((stat.mode & 0o111) !== 0 && (stat.mode & 0o111) !== 0o111) throw new Error(`Package executable is not runnable by every Mac user: ${key}`);
      result[key] = { sha256: await digest(path), size: stat.size, executable: Boolean(stat.mode & 0o111) };
    } else {
      throw new Error(`Unsupported package entry: ${key}`);
    }
  }
  return result;
}

export async function verifyPayload(app, { inventory, create = false } = {}) {
  const root = await realpath(app);
  const actual = await entries(root);
  const expected = create ? { inventory, files: actual } : JSON.parse(await readFile(join(root, manifestPath), 'utf8'));
  if (!expected.inventory?.components || !expected.files) throw new Error('Invalid application payload manifest');
  for (const [component, paths] of Object.entries(expected.inventory.components)) {
    for (const path of paths) if (!actual[path]) throw new Error(`Missing ${component}: ${path}`);
  }
  for (const path of expected.inventory.required_executables || []) {
    if (actual[path]?.executable !== true) throw new Error(`Required package executable is not runnable: ${path}`);
  }
  if (!create) {
    for (const [path, entry] of Object.entries(expected.files)) {
      if (JSON.stringify(actual[path]) !== JSON.stringify(entry)) throw new Error(`Package content mismatch: ${path}`);
    }
    const extra = Object.keys(actual).find(path => !Object.hasOwn(expected.files, path));
    if (extra) throw new Error(`Unexpected package content: ${extra}`);
  } else {
    await writeFile(join(root, manifestPath), JSON.stringify({ schema_version: 1, ...expected }, null, 2) + '\n');
  }
  return { components: Object.keys(expected.inventory.components), files: Object.keys(actual).length };
}

// Node resolves the entry module to its real path. macOS /tmp and /var are
// aliases; compare real paths so command-line verification cannot silently skip.
if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  try {
    const [mode, app, inventoryFile] = process.argv.slice(2);
    if (!['create', 'verify'].includes(mode) || !app) throw new Error('Usage: verify-package-payload.mjs create|verify application.app [inventory.json]');
    const inventory = mode === 'create' ? JSON.parse(await readFile(inventoryFile, 'utf8')) : undefined;
    const result = await verifyPayload(app, { create: mode === 'create', inventory });
    console.log(`FLOYD_PAYLOAD PASS components=${result.components.length} files=${result.files}`);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
