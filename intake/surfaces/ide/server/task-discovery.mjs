import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const ALLOWED = new Set(['node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'vitest', 'pytest', 'python3', 'cargo', 'go', 'make']);

/** Discover executable task vectors without invoking a shell or evaluating workspace code. */
export function createTaskDiscovery({ workspaceRoot }) {
  let root = workspaceRoot;
  return {
    setWorkspaceRoot(nextRoot) { root = nextRoot; },
    async list() {
      const tasks = [];
      const packageJson = await readJson(join(root, 'package.json'));
      if (packageJson?.scripts && typeof packageJson.scripts === 'object') {
        const manager = await detectPackageManager(root);
        for (const name of Object.keys(packageJson.scripts).sort()) {
          tasks.push(task(`package:${name}`, name, manager, ['run', name], /(^|:)(test|check|lint|typecheck|build)($|:)/i.test(name) ? 'test' : 'task', 'package.json'));
        }
      }
      if (await exists(join(root, 'Cargo.toml'))) {
        tasks.push(task('cargo:test', 'Cargo test', 'cargo', ['test'], 'test', 'Cargo.toml'), task('cargo:check', 'Cargo check', 'cargo', ['check'], 'test', 'Cargo.toml'));
      }
      if (await exists(join(root, 'go.mod'))) tasks.push(task('go:test', 'Go test', 'go', ['test', './...'], 'test', 'go.mod'));
      if (await exists(join(root, 'pyproject.toml')) || await exists(join(root, 'pytest.ini')) || await exists(join(root, 'tests'))) {
        tasks.push(task('pytest', 'Pytest', 'pytest', [], 'test', 'Python project'));
      }
      const makefile = (await readText(join(root, 'Makefile'))) || (await readText(join(root, 'makefile')));
      if (makefile) {
        for (const name of Array.from(makefile.matchAll(/^([A-Za-z0-9][A-Za-z0-9_.-]*):(?:\s|$)/gm), (match) => match[1]).filter((name) => !name.startsWith('.')).slice(0, 100)) {
          tasks.push(task(`make:${name}`, `make ${name}`, 'make', [name], /test|check|lint/i.test(name) ? 'test' : 'task', 'Makefile'));
        }
      }
      tasks.push(...await vscodeTasks(root));
      return deduplicate(tasks);
    },
  };
}

async function vscodeTasks(root) {
  const document = await readJsonc(join(root, '.vscode', 'tasks.json'));
  if (!Array.isArray(document?.tasks)) return [];
  const output = [];
  for (const [index, entry] of document.tasks.entries()) {
    if (!entry || typeof entry !== 'object') continue;
    let executable, args;
    if (entry.type === 'npm' && typeof entry.script === 'string') { executable = 'npm'; args = ['run', entry.script]; }
    else if ((entry.type === 'process' || entry.type === 'shell') && typeof entry.command === 'string' && ALLOWED.has(entry.command) && Array.isArray(entry.args) && entry.args.every(safeArgument)) {
      executable = entry.command; args = entry.args;
    }
    if (!executable) continue;
    const label = typeof entry.label === 'string' ? entry.label : `VS Code task ${index + 1}`;
    output.push(task(`vscode:${index}:${label}`, label, executable, args, entry.group === 'test' || /test|check|lint/i.test(label) ? 'test' : 'task', '.vscode/tasks.json'));
  }
  return output;
}

function task(id, label, executable, args, kind, source) { return { id, label, executable, args, kind, source }; }
function safeArgument(value) { return typeof value === 'string' && value.length <= 4096 && !/[\0\r\n]/.test(value) && !/\$\{|\$\(|`/.test(value); }
function deduplicate(tasks) { const seen = new Set(); return tasks.filter((item) => { const key = `${item.executable}\0${item.args.join('\0')}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
async function exists(path) { try { await stat(path); return true; } catch { return false; } }
async function readText(path) { try { return await readFile(path, 'utf8'); } catch { return null; } }
async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
async function readJsonc(path) { const text = await readText(path); if (!text) return null; try { return JSON.parse(stripJsonc(text)); } catch { return null; } }
async function detectPackageManager(root) { return await exists(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : await exists(join(root, 'yarn.lock')) ? 'yarn' : await exists(join(root, 'bun.lockb')) || await exists(join(root, 'bun.lock')) ? 'bun' : 'npm'; }
function stripJsonc(input) {
  let output = '', string = false, escaped = false, line = false, block = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index], next = input[index + 1];
    if (line) { if (char === '\n') { line = false; output += char; } continue; }
    if (block) { if (char === '*' && next === '/') { block = false; index += 1; } continue; }
    if (!string && char === '/' && next === '/') { line = true; index += 1; continue; }
    if (!string && char === '/' && next === '*') { block = true; index += 1; continue; }
    if (!string && char === ',') { let cursor = index + 1; while (/\s/.test(input[cursor] || '')) cursor += 1; if (input[cursor] === '}' || input[cursor] === ']') continue; }
    output += char;
    if (string && char === '\\' && !escaped) { escaped = true; continue; }
    if (char === '"' && !escaped) string = !string;
    escaped = false;
  }
  return output;
}
