import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

if (process.platform !== 'darwin') throw new Error('The local CURSEM app packager requires macOS.');
const exec = promisify(execFile);
const root = process.cwd();
const output = resolve(process.env.CURSEM_APP_OUTPUT || 'artifacts/CURSEM.app');
const contents = join(output, 'Contents'), resources = join(contents, 'Resources'), runtime = join(resources, 'runtime');
await rm(output, { recursive: true, force: true });
await mkdir(join(contents, 'MacOS'), { recursive: true });
await mkdir(join(runtime, 'bin'), { recursive: true });
await cp(join(root, 'dist'), join(runtime, 'dist'), { recursive: true });
await cp(join(root, 'server'), join(runtime, 'server'), { recursive: true });
await mkdir(join(runtime, 'src', 'model-routing'), { recursive: true });
await cp(join(root, 'src', 'model-routing', 'core.mjs'), join(runtime, 'src', 'model-routing', 'core.mjs'));
await cp(join(root, 'vendor', 'TerminalOne'), join(runtime, 'vendor', 'TerminalOne'), { recursive: true, filter: (source) => !source.includes('/node_modules/') && !source.includes('/tests/') });
await bundleNodeRuntime(process.execPath, runtime);
await copyProductionModules(root, runtime);
await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: 'cursem-packaged-runtime', private: true, type: 'module' }, null, 2));
const packagedNode = join(runtime, 'bin', 'node');
await writeFile(join(contents, 'Info.plist'), plist());
await exec('xcrun', ['swiftc', join(root, 'scripts', 'CURSEMLauncher.swift'), '-o', join(contents, 'MacOS', 'CURSEM'), '-framework', 'Cocoa']);
const signedRuntimeBinaries = await signRuntimeBinaries(runtime);
await exec('codesign', ['--force', '--sign', '-', output]);
const verification = await exec('codesign', ['--verify', '--deep', '--strict', '--verbose=2', output]);
const nodeVerification = await exec(packagedNode, ['--version']);
process.stdout.write(`Packaged local app: ${output}\nBundled Node verified: ${nodeVerification.stdout.trim()}\nSigned runtime binaries: ${signedRuntimeBinaries}\nAd-hoc signature verified.${verification.stderr ? `\n${verification.stderr}` : ''}\n`);

async function signRuntimeBinaries(directory) {
  let signed = 0;
  for (const file of await listFiles(directory)) {
    const inspection = await exec('file', ['-b', file]);
    if (!inspection.stdout.includes('Mach-O')) continue;
    await exec('codesign', ['--force', '--sign', '-', file]);
    signed += 1;
  }
  return signed;
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function bundleNodeRuntime(nodeExecutable, destinationRoot) {
  const executable = await realpath(nodeExecutable);
  const binDirectory = join(destinationRoot, 'bin');
  const libraryDirectory = join(destinationRoot, 'lib');
  await mkdir(libraryDirectory, { recursive: true });

  const graph = new Map();
  const destinations = new Map();
  const queue = [executable];
  while (queue.length) {
    const source = queue.shift();
    if (graph.has(source)) continue;
    const destination = source === executable
      ? join(binDirectory, 'node')
      : join(libraryDirectory, basename(source));
    const existingSource = destinations.get(destination);
    if (existingSource && existingSource !== source) {
      throw new Error(`Cannot bundle Node runtime libraries with duplicate name ${basename(source)}.`);
    }
    destinations.set(destination, source);

    const dependencies = [];
    for (const reference of await linkedLibraries(source)) {
      const dependency = await resolveLinkedLibrary(reference, source, executable);
      if (!dependency) continue;
      dependencies.push({ reference, source: dependency });
      if (!graph.has(dependency)) queue.push(dependency);
    }
    graph.set(source, { destination, dependencies });
  }

  for (const [source, node] of graph) await cp(source, node.destination, { dereference: true });
  for (const [source, node] of graph) {
    for (const dependency of node.dependencies) {
      const bundled = graph.get(dependency.source);
      if (!bundled) throw new Error(`Missing bundled Node dependency ${dependency.reference}.`);
      const replacement = source === executable
        ? `@executable_path/../lib/${basename(bundled.destination)}`
        : `@loader_path/${basename(bundled.destination)}`;
      await exec('install_name_tool', ['-change', dependency.reference, replacement, node.destination]);
    }
    if (source !== executable) await exec('install_name_tool', ['-id', `@rpath/${basename(node.destination)}`, node.destination]);
  }
}

async function linkedLibraries(binary) {
  const { stdout } = await exec('otool', ['-L', binary]);
  return stdout.split('\n').slice(1).map((line) => line.trim().split(' (')[0]).filter(Boolean);
}

async function resolveLinkedLibrary(reference, binary, executable) {
  if (reference.startsWith('/System/') || reference.startsWith('/usr/lib/')) return null;
  const candidates = [];
  if (isAbsolute(reference)) candidates.push(reference);
  else if (reference.startsWith('@loader_path/')) candidates.push(join(dirname(binary), reference.slice('@loader_path/'.length)));
  else if (reference.startsWith('@executable_path/')) candidates.push(join(dirname(executable), reference.slice('@executable_path/'.length)));
  else if (reference.startsWith('@rpath/')) {
    const relative = reference.slice('@rpath/'.length);
    candidates.push(join(dirname(binary), relative), join(dirname(dirname(binary)), 'lib', relative), join(dirname(dirname(executable)), 'lib', relative));
  }
  for (const candidate of candidates) {
    try { return await realpath(candidate); }
    catch { /* try the next loader search path */ }
  }
  throw new Error(`Cannot resolve Node runtime dependency ${reference} from ${binary}.`);
}

async function copyProductionModules(projectRoot, destinationRoot) {
  const lock = JSON.parse(await readFile(join(projectRoot, 'package-lock.json'), 'utf8'));
  const entries = Object.entries(lock.packages || {}).filter(([path, metadata]) => path.startsWith('node_modules/') && metadata.dev !== true);
  for (const [path] of entries) {
    const source = join(projectRoot, path), destination = join(destinationRoot, path);
    try { await mkdir(join(destination, '..'), { recursive: true }); await cp(source, destination, { recursive: true }); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

function plist() { return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>CURSEM</string>
<key>CFBundleIdentifier</key><string>com.cursem.ide.local</string>
<key>CFBundleName</key><string>CURSEM</string>
<key>CFBundleDisplayName</key><string>CURSEM IDE</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`; }
