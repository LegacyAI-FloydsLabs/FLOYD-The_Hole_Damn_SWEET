import { execFile } from 'node:child_process';
import { watch } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_FILES = 1_000_000;
const MAX_INDEX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_RESOLVE_CHARS = 256 * 1024;
const DEFAULT_EXCLUDES = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.cache', 'vendor']);
const SENSITIVE = /(^|\/)(\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|crt)|id_(?:rsa|ed25519)|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml))$/i;
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc', '.md', '.mdc', '.txt', '.css', '.scss', '.less', '.html', '.htm', '.py', '.rs', '.go', '.java', '.kt', '.kts', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.sh', '.bash', '.zsh', '.fish', '.sql', '.yaml', '.yml', '.toml', '.xml', '.vue', '.svelte', '.astro', '.graphql', '.gql']);

/**
 * Local in-memory repository context index. Indexing honors Git exclusions,
 * CURSEM exclusions, binary/size guards, and sensitive-path defaults. Nothing
 * in this service contacts a model provider; callers must explicitly resolve
 * selected results before the browser can include them in a model request.
 */
export function createRepositoryContext({ workspaceRoot }) {
  let root = workspaceRoot;
  let index = new Map();
  let indexedAt = 0;
  let dirty = true;
  let indexing = null;
  let watcher = null;

  const startWatcher = () => {
    watcher?.close(); watcher = null;
    try {
      watcher = watch(root, { recursive: true }, (_event, filename) => {
        const path = String(filename || '');
        if (!isExcluded(path, [])) dirty = true;
      });
    } catch { /* recursive watch is unavailable on some hosts; refresh remains explicit */ }
  };
  startWatcher();

  async function refresh() {
    if (indexing) return indexing;
    indexing = buildIndex(root).then((entries) => {
      index = entries; indexedAt = Date.now(); dirty = false;
      return status();
    }).finally(() => { indexing = null; });
    return indexing;
  }

  async function ensure() { if (dirty || !indexedAt) await refresh(); }
  function status() {
    let bytes = 0; for (const entry of index.values()) bytes += entry.bytes;
    return { root, files: index.size, bytes, indexedAt, dirty, indexing: Boolean(indexing) };
  }

  return {
    setWorkspaceRoot(nextRoot) { root = nextRoot; index = new Map(); indexedAt = 0; dirty = true; startWatcher(); },
    status,
    refresh,
    async search(query, limit = 20) {
      await ensure();
      const terms = tokenize(query);
      if (!terms.length) return [];
      return Array.from(index.values()).map((entry) => scoreEntry(entry, terms)).filter((result) => result.score > 0)
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, clamp(limit, 1, 100));
    },
    async resolve(selectors, budgetChars = 64 * 1024) {
      await ensure();
      if (!Array.isArray(selectors) || selectors.length === 0) return { items: [], totalChars: 0, budgetChars: 0 };
      const budget = clamp(budgetChars, 1024, MAX_RESOLVE_CHARS);
      const candidates = [];
      for (const selector of selectors) {
        if (!selector || typeof selector.type !== 'string' || typeof selector.value !== 'string') continue;
        const value = selector.value.replace(/^\.\//, '');
        if (selector.type === 'file') {
          const entry = index.get(value); if (entry) candidates.push({ ...entry, reason: `explicit file: ${value}` });
        } else if (selector.type === 'folder') {
          const prefix = value.replace(/\/$/, '');
          for (const entry of index.values()) if (entry.path === prefix || entry.path.startsWith(`${prefix}/`)) candidates.push({ ...entry, reason: `explicit folder: ${value}` });
        } else if (selector.type === 'symbol') {
          const matches = Array.from(index.values()).filter((entry) => entry.symbols.some((symbol) => symbol.toLowerCase() === value.toLowerCase()));
          for (const entry of matches) candidates.push({ ...entry, reason: `symbol: ${value}` });
        }
      }
      const items = []; const seen = new Set(); let totalChars = 0;
      for (const entry of candidates.sort((a, b) => a.path.localeCompare(b.path))) {
        if (seen.has(entry.path)) continue;
        const remaining = budget - totalChars; if (remaining <= 0) break;
        const content = entry.content.slice(0, remaining);
        items.push({ path: entry.path, content, reason: entry.reason, chars: content.length, truncated: content.length < entry.content.length });
        seen.add(entry.path); totalChars += content.length;
      }
      return { items, totalChars, budgetChars: budget };
    },
    async rules(filePath = '') { return discoverRules(root, filePath); },
    close() { watcher?.close(); watcher = null; index.clear(); },
  };
}

async function buildIndex(root) {
  const cursemIgnore = await readIgnore(resolve(root, '.cursemignore'));
  const paths = await listCandidateFiles(root, cursemIgnore);
  const entries = new Map();
  for (const path of paths.slice(0, MAX_FILES)) {
    if (isExcluded(path, cursemIgnore) || SENSITIVE.test(path) || !isTextPath(path)) continue;
    const absolute = resolve(root, path);
    try {
      const metadata = await stat(absolute);
      if (!metadata.isFile() || metadata.size > MAX_INDEX_FILE_BYTES) continue;
      const buffer = await readFile(absolute);
      if (buffer.includes(0)) continue;
      const content = buffer.toString('utf8');
      entries.set(path, {
        path, basename: basename(path), extension: extname(path).toLowerCase(), content,
        lower: content.toLowerCase(), symbols: extractSymbols(content), imports: extractImports(content),
        bytes: metadata.size, mtimeMs: metadata.mtimeMs,
      });
    } catch { /* a concurrent filesystem change is picked up by the next refresh */ }
  }
  return entries;
}

async function listCandidateFiles(root, cursemIgnore) {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
    return stdout.toString('utf8').split('\0').filter(Boolean).filter((path) => !isExcluded(path, cursemIgnore));
  } catch { return walk(root, root, cursemIgnore); }
}

async function walk(root, directory, ignores, output = []) {
  if (output.length >= MAX_FILES) return output;
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, item.name); const path = relative(root, absolute);
    if (isExcluded(path, ignores) || item.isSymbolicLink()) continue;
    if (item.isDirectory()) await walk(root, absolute, ignores, output);
    else if (item.isFile()) output.push(path);
    if (output.length >= MAX_FILES) break;
  }
  return output;
}

function scoreEntry(entry, terms) {
  let score = 0; const reasons = [];
  const lowerPath = entry.path.toLowerCase(); const lowerBase = entry.basename.toLowerCase();
  for (const term of terms) {
    if (lowerBase === term) { score += 80; reasons.push(`filename equals ${term}`); }
    else if (lowerPath.includes(term)) { score += 25; reasons.push(`path contains ${term}`); }
    if (entry.symbols.some((symbol) => symbol.toLowerCase() === term)) { score += 60; reasons.push(`symbol ${term}`); }
    else if (entry.symbols.some((symbol) => symbol.toLowerCase().includes(term))) { score += 25; reasons.push(`symbol contains ${term}`); }
    if (entry.imports.some((value) => value.toLowerCase().includes(term))) { score += 18; reasons.push(`import contains ${term}`); }
    const occurrences = countOccurrences(entry.lower, term, 8);
    if (occurrences) { score += occurrences * 4; reasons.push(`${occurrences} text match${occurrences === 1 ? '' : 'es'}`); }
  }
  return { path: entry.path, score, reasons: [...new Set(reasons)], symbols: entry.symbols.slice(0, 20), snippet: snippet(entry.content, terms) };
}

function snippet(content, terms) {
  const lower = content.toLowerCase(); let at = -1;
  for (const term of terms) { const found = lower.indexOf(term); if (found >= 0 && (at < 0 || found < at)) at = found; }
  if (at < 0) return content.slice(0, 240).trim();
  return content.slice(Math.max(0, at - 100), Math.min(content.length, at + 180)).replace(/\s+/g, ' ').trim();
}

function extractSymbols(content) {
  const symbols = new Set();
  const patterns = [
    /\b(?:class|interface|type|enum|function|const|let|var|def|struct|trait|fn|func)\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+default\s+(?:class|function)\s+([A-Za-z_$][\w$]*)/g,
  ];
  for (const pattern of patterns) for (const match of content.matchAll(pattern)) symbols.add(match[1]);
  return Array.from(symbols).slice(0, 500);
}

function extractImports(content) {
  const imports = new Set();
  for (const match of content.matchAll(/(?:from\s+|require\s*\(|import\s*\()["']([^"']+)["']/g)) imports.add(match[1]);
  return Array.from(imports).slice(0, 500);
}

async function discoverRules(root, filePath) {
  const candidates = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md', '.cursorrules']) {
    const path = resolve(root, name); try { candidates.push(await ruleRecord(root, path, 'root', true)); } catch {}
  }
  for (const directory of ['.cursor/rules', '.cursem/rules']) {
    const absolute = resolve(root, directory);
    try {
      for (const path of await walk(root, absolute, [], [])) {
        if (!path.startsWith(`${directory}/`) || !/\.(?:md|mdc)$/i.test(path)) continue;
        candidates.push(await ruleRecord(root, resolve(root, path), directory.startsWith('.cursor') ? 'cursor' : 'cursem', false));
      }
    } catch {}
  }
  const target = filePath.replace(/^\.\//, '');
  return {
    applied: candidates.filter((rule) => rule.alwaysApply || matchesRule(rule, target)),
    available: candidates,
  };
}

async function ruleRecord(root, path, source, rootRule) {
  const content = await readFile(path, 'utf8');
  const metadata = parseFrontmatter(content);
  return {
    path: relative(root, path), source, description: metadata.description || basename(path),
    globs: metadata.globs, alwaysApply: rootRule || metadata.alwaysApply,
    content: metadata.body, chars: metadata.body.length,
  };
}

function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return { description: '', globs: [], alwaysApply: false, body: content };
  const description = match[1].match(/^description:\s*(.+)$/m)?.[1]?.trim() || '';
  const globsRaw = match[1].match(/^globs:\s*(.*)$/m)?.[1]?.trim() || '';
  const globs = globsRaw.replace(/^\[|\]$/g, '').split(',').map((value) => value.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const alwaysApply = /^(true|yes)$/i.test(match[1].match(/^alwaysApply:\s*(.+)$/m)?.[1]?.trim() || '');
  return { description, globs, alwaysApply, body: content.slice(match[0].length) };
}

function matchesRule(rule, path) {
  if (!path || !rule.globs.length) return false;
  return rule.globs.some((glob) => simpleGlob(path, glob));
}

function simpleGlob(path, glob) {
  let pattern = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      index += 1;
      if (glob[index + 1] === '/') { index += 1; pattern += '(?:.*/)?'; }
      else pattern += '.*';
    } else if (char === '*') pattern += '[^/]*';
    else if (char === '?') pattern += '[^/]';
    else pattern += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`).test(path);
}

async function readIgnore(path) { try { return (await readFile(path, 'utf8')).split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#')); } catch { return []; } }
function isExcluded(path, ignores) {
  const parts = path.split(/[\\/]/); if (parts.some((part) => DEFAULT_EXCLUDES.has(part))) return true;
  return ignores.some((pattern) => simpleGlob(path, pattern.replace(/^\//, '')) || path.startsWith(`${pattern.replace(/\/$/, '')}/`));
}
function isTextPath(path) { return TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || !extname(path); }
function tokenize(value) { return String(value || '').toLowerCase().match(/[a-z0-9_$.-]{2,}/g)?.slice(0, 12) || []; }
function countOccurrences(text, term, limit) { let count = 0; let at = 0; while (count < limit && (at = text.indexOf(term, at)) >= 0) { count += 1; at += term.length; } return count; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || min)); }
