// skills-manager.mjs — Skills registry backend for the standalone CURSEM host.
//
// Serves a merged skill catalog (remote index with a 30-minute TTL, bundled
// seed fallback), previews skill packages, installs/uninstalls SKILL.md
// packages into per-target directory conventions under the workspace root
// (always through the host's WorkspaceBoundary), keeps the per-workspace
// install ledger at .cursem/skills.json, and auto-seeds the first-party
// cursem-workspace skill with content-hash gating (unedited copies upgrade,
// user-edited copies are never overwritten, explicit uninstalls stick).
// Any GitHub token comes from the server environment only — never the
// renderer, and outbound fetches are pinned to GitHub hosts.

import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
// server/ -> ide/ -> surfaces/ -> intake/ -> repository root.
const DEFAULT_SOURCE_ROOT = resolve(MODULE_DIR, '..', '..', '..', '..');
const DEFAULT_SEED_DIR = join(MODULE_DIR, 'seed-skills');

const INDEX_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_SKILL_FILES = 200;
const MAX_SKILL_FILE_BYTES = 1024 * 1024;
const MAX_SKILL_TOTAL_BYTES = 8 * 1024 * 1024;
const LEDGER_RELATIVE = join('.cursem', 'skills.json');

/** Install targets: every target uses folder layout under the workspace root. */
export const SKILL_TARGETS = [
  { id: 'cursem', label: 'CURSEM (this IDE)', dir: '.cursem/skills', injects: true },
  { id: 'claude-code', label: 'Claude Code', dir: '.claude/skills' },
  { id: 'codex', label: 'Codex', dir: '.codex/skills' },
  { id: 'cursor', label: 'Cursor', dir: '.cursor/skills' },
  { id: 'grok', label: 'Grok', dir: '.grok/skills' },
  { id: 'opencode', label: 'OpenCode', dir: '.opencode/skills' },
  { id: 'pi-native', label: 'Pi (.agents)', dir: '.agents/skills' },
];

const TARGET_BY_ID = new Map(SKILL_TARGETS.map((target) => [target.id, target]));

export function createSkillsManager({
  boundary,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  sourceRoot = environment.CURSEM_SKILLS_SOURCE_ROOT || DEFAULT_SOURCE_ROOT,
  seedDir = environment.CURSEM_SKILLS_SEED_DIR || DEFAULT_SEED_DIR,
  indexUrl = environment.CURSEM_SKILLS_INDEX_URL || '',
} = {}) {
  if (!boundary) throw new Error('skills-manager requires the host WorkspaceBoundary.');
  const githubToken = environment.CURSEM_SKILLS_GITHUB_TOKEN || environment.GITHUB_TOKEN || '';
  let indexCache = { at: 0, payload: null };

  // -- Catalog -------------------------------------------------------------

  async function loadSeedIndex() {
    try {
      const parsed = JSON.parse(await readFile(join(seedDir, 'skills-index.json'), 'utf8'));
      return (Array.isArray(parsed?.skills) ? parsed.skills : []).filter(isCatalogEntry);
    } catch {
      return [];
    }
  }

  async function fetchRemoteIndex() {
    if (!indexUrl) return null;
    assertGithubOrLoopback(indexUrl);
    const response = await fetchWithTimeout(indexUrl, {
      headers: { accept: 'application/json', ...authHeaders() },
    });
    if (!response.ok) throw httpError(502, `Skills index fetch failed: HTTP ${response.status}`);
    const parsed = await response.json();
    return (Array.isArray(parsed?.skills) ? parsed.skills : []).filter(isCatalogEntry);
  }

  async function index({ refresh = false } = {}) {
    if (!refresh && indexCache.payload && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.payload;
    const seed = await loadSeedIndex();
    let remote = null;
    try { remote = await fetchRemoteIndex(); } catch { /* seed fallback */ }
    const merged = new Map();
    for (const entry of seed) merged.set(entry.id, entry);
    for (const entry of remote || []) merged.set(entry.id, entry);
    const payload = {
      skills: Array.from(merged.values()),
      targets: SKILL_TARGETS,
      origin: remote ? 'merged' : 'seed',
      fetchedAt: new Date().toISOString(),
    };
    indexCache = { at: Date.now(), payload };
    return payload;
  }

  async function preview(id) {
    const { skills } = await index();
    const entry = skills.find((candidate) => candidate.id === id);
    if (!entry) throw httpError(404, `Skill not found in catalog: ${id}`);
    const files = await resolveFiles(entry);
    const skillFile = files.find((file) => file.path === 'SKILL.md');
    return {
      entry,
      files: files.map((file) => ({ path: file.path, bytes: file.content.byteLength })),
      skillMd: skillFile ? skillFile.content.toString('utf8') : '',
    };
  }

  // -- Install / uninstall -------------------------------------------------

  async function install({ entry, targetId } = {}) {
    const target = TARGET_BY_ID.get(String(targetId || ''));
    if (!target) throw httpError(400, `Unknown skills target: ${targetId || '(none)'}`);
    assertInstallableEntry(entry);
    const slug = slugify(entry.name || entry.id);
    const files = await resolveFiles(entry);
    const targetDir = join(boundary.root, target.dir, slug);
    for (const file of files) {
      const destination = join(targetDir, file.path);
      if (relative(targetDir, destination).startsWith(`..${sep}`) || relative(targetDir, destination) === '..') {
        throw httpError(403, `Skill file escapes the target directory: ${file.path}`);
      }
      const confined = await boundary.writable(destination);
      await mkdir(dirname(confined), { recursive: true });
      const content = file.path === 'SKILL.md'
        ? Buffer.from(forceNameFrontmatter(file.content.toString('utf8'), slug), 'utf8')
        : file.content;
      await writeFile(confined, content);
    }
    const ledger = await readLedger();
    ledger.installed = ledger.installed.filter((record) => !(record.slug === slug && record.target === target.id));
    ledger.installed.push({
      slug,
      name: entry.name,
      target: target.id,
      source: entry.source,
      firstParty: Boolean(entry.firstParty),
      installedAt: new Date().toISOString(),
      files: files.map((file) => file.path),
    });
    ledger.uninstalledSeeds = ledger.uninstalledSeeds.filter((seedSlug) => seedSlug !== slug);
    await writeLedger(ledger);
    return { slug, target: target.id, path: targetDir, files: files.map((file) => file.path) };
  }

  async function uninstall({ slug, target: targetId } = {}) {
    const target = TARGET_BY_ID.get(String(targetId || ''));
    if (!target) throw httpError(400, `Unknown skills target: ${targetId || '(none)'}`);
    const safeSlug = assertSlug(slug);
    const ledger = await readLedger();
    const record = ledger.installed.find((candidate) => candidate.slug === safeSlug && candidate.target === target.id);
    const targetDir = join(boundary.root, target.dir, safeSlug);
    const existedOnDisk = await exists(targetDir);
    if (existedOnDisk) {
      const confined = await boundary.existing(targetDir);
      if (confined === boundary.root) throw httpError(400, 'Refusing to remove the workspace root.');
      await rm(confined, { recursive: true, force: false });
    }
    ledger.installed = ledger.installed.filter((candidate) => !(candidate.slug === safeSlug && candidate.target === target.id));
    if (record?.firstParty && target.id === 'cursem' && !ledger.uninstalledSeeds.includes(safeSlug)) {
      ledger.uninstalledSeeds.push(safeSlug);
    }
    delete ledger.seeds[safeSlug];
    await writeLedger(ledger);
    return { ok: true, removed: Boolean(record) || existedOnDisk };
  }

  async function installed() {
    const ledger = await readLedger();
    const skills = [];
    for (const record of ledger.installed) {
      const target = TARGET_BY_ID.get(record.target);
      if (!target) continue;
      const targetDir = join(boundary.root, target.dir, record.slug);
      if (!(await exists(targetDir))) continue;
      const entry = {
        slug: record.slug,
        name: record.name,
        target: record.target,
        path: targetDir,
        source: record.source,
        installedAt: record.installedAt,
      };
      if (target.id === 'cursem') {
        try { entry.content = await readFile(join(targetDir, 'SKILL.md'), 'utf8'); } catch { /* unreadable */ }
      }
      skills.push(entry);
    }
    return { skills };
  }

  // -- First-party seeding (content-hash gated) -----------------------------

  async function seed() {
    const seedEntries = (await loadSeedIndex()).filter((entry) => entry.firstParty && entry.sourceId === 'cursem-seed');
    for (const entry of seedEntries) {
      const slug = slugify(entry.name || entry.id);
      const ledger = await readLedger();
      if (ledger.uninstalledSeeds.includes(slug)) continue;
      const files = await resolveFiles(entry);
      // Hash the bytes as they will be installed (frontmatter name forced to
      // the slug) so comparisons against on-disk content are exact.
      const bundleHash = hashFiles(files.map((file) => file.path === 'SKILL.md'
        ? { ...file, content: Buffer.from(forceNameFrontmatter(file.content.toString('utf8'), slug), 'utf8') }
        : file));
      const skillPath = join(boundary.root, '.cursem', 'skills', slug, 'SKILL.md');
      const onDiskHash = await hashFileIfPresent(skillPath);
      const recorded = ledger.seeds[slug];
      if (!onDiskHash) {
        await install({ entry, targetId: 'cursem' });
        const next = await readLedger();
        // Record the hash of the installed bytes (post frontmatter-forcing),
        // not the raw bundle, so the unedited-copy check compares like to like.
        next.seeds[slug] = { hash: (await hashFileIfPresent(skillPath)) || bundleHash, updatedAt: new Date().toISOString() };
        await writeLedger(next);
      } else if (!recorded) {
        // Pre-existing foreign copy: adopt its hash without touching content.
        ledger.seeds[slug] = { hash: onDiskHash, updatedAt: new Date().toISOString() };
        await writeLedger(ledger);
      } else if (onDiskHash === recorded.hash && onDiskHash !== bundleHash) {
        // Unedited seeded copy: upgrade in place.
        await install({ entry, targetId: 'cursem' });
        const next = await readLedger();
        next.seeds[slug] = { hash: (await hashFileIfPresent(skillPath)) || bundleHash, updatedAt: new Date().toISOString() };
        await writeLedger(next);
      }
      // User-edited copies (on-disk hash differs from the recorded hash) are
      // never overwritten.
    }
  }

  // -- File resolution ------------------------------------------------------

  async function resolveFiles(entry) {
    if (entry.sourceId === 'cursem-seed' || (entry.firstParty && entry.source?.repo === 'local' && entry.source?.path?.startsWith('seed-skills/'))) {
      return readLocalSkill(resolve(seedDir, basename(entry.source.path)));
    }
    if (entry.source.repo === 'local') {
      const base = resolve(sourceRoot, entry.source.path);
      if (base !== sourceRoot && !base.startsWith(`${sourceRoot}${sep}`)) {
        throw httpError(403, `Local skill source escapes the skills source root: ${entry.source.path}`);
      }
      return readLocalSkill(base);
    }
    return fetchGithubSkill(entry.source);
  }

  async function readLocalSkill(base) {
    const resolvedBase = await realpath(base).catch(() => {
      throw httpError(404, `Local skill source not found: ${base}`);
    });
    const files = [];
    let total = 0;
    const walk = async (directory) => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const item of entries) {
        const path = join(directory, item.name);
        if (item.isDirectory()) { await walk(path); continue; }
        if (!item.isFile()) continue;
        const real = await realpath(path);
        if (real !== resolvedBase && !real.startsWith(`${resolvedBase}${sep}`)) {
          throw httpError(403, `Skill file escapes its source directory: ${path}`);
        }
        const content = await readFile(real);
        total += content.byteLength;
        if (content.byteLength > MAX_SKILL_FILE_BYTES) throw httpError(413, `Skill file exceeds ${MAX_SKILL_FILE_BYTES} bytes: ${relative(resolvedBase, real)}`);
        if (total > MAX_SKILL_TOTAL_BYTES) throw httpError(413, `Skill package exceeds ${MAX_SKILL_TOTAL_BYTES} bytes.`);
        files.push({ path: relative(resolvedBase, real).split(sep).join('/'), content });
        if (files.length > MAX_SKILL_FILES) throw httpError(413, `Skill package exceeds ${MAX_SKILL_FILES} files.`);
      }
    };
    await walk(resolvedBase);
    assertSkillPackage(files, base);
    return files;
  }

  async function fetchGithubSkill(source) {
    const repo = String(source.repo || '');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw httpError(400, `Invalid GitHub repository: ${repo}`);
    const ref = String(source.ref || 'HEAD');
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(ref) || ref.includes('..')) throw httpError(400, `Invalid GitHub ref: ${ref}`);
    const prefix = String(source.path || '').replace(/^\/+|\/+$/g, '');
    if (prefix.split('/').some((segment) => segment === '..')) throw httpError(400, 'Skill source path cannot contain ..');
    const treeUrl = `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
    const response = await fetchWithTimeout(treeUrl, { headers: { accept: 'application/vnd.github+json', ...authHeaders() } });
    if (!response.ok) throw httpError(502, `GitHub tree fetch failed for ${repo}@${ref}: HTTP ${response.status}`);
    const tree = await response.json();
    const wanted = (Array.isArray(tree?.tree) ? tree.tree : []).filter((node) =>
      node.type === 'blob' && typeof node.path === 'string'
      && (prefix ? node.path.startsWith(`${prefix}/`) : true),
    );
    const files = [];
    let total = 0;
    for (const node of wanted.slice(0, MAX_SKILL_FILES + 1)) {
      const relativePath = prefix ? node.path.slice(prefix.length + 1) : node.path;
      const rawUrl = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${node.path.split('/').map(encodeURIComponent).join('/')}`;
      const raw = await fetchWithTimeout(rawUrl, { headers: authHeaders() });
      if (!raw.ok) throw httpError(502, `GitHub raw fetch failed for ${node.path}: HTTP ${raw.status}`);
      const content = Buffer.from(await raw.arrayBuffer());
      total += content.byteLength;
      if (content.byteLength > MAX_SKILL_FILE_BYTES) throw httpError(413, `Skill file exceeds ${MAX_SKILL_FILE_BYTES} bytes: ${node.path}`);
      if (total > MAX_SKILL_TOTAL_BYTES) throw httpError(413, `Skill package exceeds ${MAX_SKILL_TOTAL_BYTES} bytes.`);
      files.push({ path: relativePath, content });
    }
    assertSkillPackage(files, `${repo}@${ref}/${prefix}`);
    return files;
  }

  // -- Ledger ---------------------------------------------------------------

  async function readLedger() {
    try {
      const parsed = JSON.parse(await readFile(join(boundary.root, LEDGER_RELATIVE), 'utf8'));
      return {
        version: 1,
        installed: Array.isArray(parsed?.installed) ? parsed.installed : [],
        uninstalledSeeds: Array.isArray(parsed?.uninstalledSeeds) ? parsed.uninstalledSeeds : [],
        seeds: parsed?.seeds && typeof parsed.seeds === 'object' ? parsed.seeds : {},
      };
    } catch {
      return { version: 1, installed: [], uninstalledSeeds: [], seeds: {} };
    }
  }

  async function writeLedger(ledger) {
    const ledgerPath = await boundary.writable(join(boundary.root, LEDGER_RELATIVE));
    await mkdir(dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  }

  // -- Helpers ----------------------------------------------------------------

  function authHeaders() {
    return githubToken ? { authorization: `Bearer ${githubToken}` } : {};
  }

  async function fetchWithTimeout(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try { return await fetchImpl(url, { ...init, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }

  return {
    index,
    preview,
    install,
    uninstall,
    installed,
    seed,
    targets: () => SKILL_TARGETS,
    async setWorkspaceRoot() { indexCache = { at: 0, payload: null }; await seed(); },
  };
}

// -- Module-level helpers -----------------------------------------------------

function isCatalogEntry(entry) {
  return entry && typeof entry === 'object'
    && typeof entry.id === 'string' && typeof entry.name === 'string'
    && entry.source && typeof entry.source === 'object'
    && typeof entry.source.repo === 'string' && typeof entry.source.path === 'string';
}

function assertInstallableEntry(entry) {
  if (!isCatalogEntry(entry)) throw httpError(400, 'A catalog entry with id, name, and source {repo, ref, path} is required.');
  if (entry.source.repo !== 'local' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.source.repo)) {
    throw httpError(400, `Skill source must be 'local' or an owner/repo GitHub slug: ${entry.source.repo}`);
  }
  if (String(entry.source.path).split('/').some((segment) => segment === '..')) {
    throw httpError(400, 'Skill source path cannot contain ..');
  }
}

function assertGithubOrLoopback(url) {
  const parsed = new URL(url);
  const allowed = parsed.protocol === 'https:'
    && ['api.github.com', 'raw.githubusercontent.com', 'github.com'].includes(parsed.hostname);
  const loopback = ['http:', 'https:'].includes(parsed.protocol)
    && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (!allowed && !loopback) throw httpError(400, `Skills index URL must be a GitHub or loopback host: ${parsed.hostname}`);
}

function assertSkillPackage(files, origin) {
  if (!files.length) throw httpError(404, `Skill package is empty: ${origin}`);
  if (files.length > MAX_SKILL_FILES) throw httpError(413, `Skill package exceeds ${MAX_SKILL_FILES} files.`);
  if (!files.some((file) => file.path === 'SKILL.md')) throw httpError(400, `Skill package has no SKILL.md at its root: ${origin}`);
  for (const file of files) {
    if (file.path.split('/').some((segment) => segment === '..' || segment === '') || file.path.startsWith('/')) {
      throw httpError(403, `Skill file path is not relative and confined: ${file.path}`);
    }
  }
}

export function slugify(name) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  if (!slug) throw httpError(400, `Skill name cannot be slugified: ${name}`);
  return slug;
}

function assertSlug(value) {
  const slug = String(value || '');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) throw httpError(400, `Invalid skill slug: ${value}`);
  return slug;
}

/**
 * Force the YAML frontmatter `name:` field to the install slug. Minimal and
 * dependency-free: only the first frontmatter block is touched; content
 * without frontmatter gets a new block prepended.
 */
export function forceNameFrontmatter(content, slug) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return `---\nname: ${slug}\n---\n\n${content}`;
  const block = match[1];
  const replaced = /^name:.*$/m.test(block)
    ? block.replace(/^name:.*$/m, `name: ${slug}`)
    : `name: ${slug}\n${block}`;
  return `---\n${replaced}\n---\n${content.slice(match[0].length)}`;
}

function hashFiles(files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path); hash.update('\0'); hash.update(file.content); hash.update('\0');
  }
  return hash.digest('hex');
}

async function hashFileIfPresent(path) {
  try {
    const content = await readFile(path);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
